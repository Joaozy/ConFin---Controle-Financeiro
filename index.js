import dotenv from 'dotenv';
import wppconnect from '@wppconnect-team/wppconnect';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import http from 'http';

dotenv.config();

// --- 0. SERVIDOR FAKE PARA O RENDER ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('🤖 Bot Financeiro está rodando!');
    res.end();
});
const port = process.env.PORT || 8080;
server.listen(port, () => console.log(`🌐 Servidor Fake ouvindo na porta ${port}`));

// --- 1. CONFIGURAÇÃO ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(supabaseUrl, supabaseKey);

// --- 2. UTILITÁRIOS ---
function normalizarParaComparacao(telefone) {
    if (!telefone) return '';
    let num = telefone.replace(/\D/g, '');
    if (num.startsWith('55')) num = num.slice(2);
    if (num.length >= 10) return num.slice(0, 2) + num.slice(-8);
    return num;
}

function padronizarCategoria(texto) {
    if (!texto) return 'Outros';
    return texto.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function buscarUsuario(telefoneDoZap) {
    const { data: profiles } = await supabase.from('profiles').select('*');
    if (!profiles) return null;
    const zapNormalizado = normalizarParaComparacao(telefoneDoZap);
    return profiles.find(p => normalizarParaComparacao(p.phone) === zapNormalizado);
}

async function analisarMensagem(texto) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const hoje = new Date().toISOString().split('T')[0];
    const prompt = `Contador. Hoje: ${hoje}. Texto: "${texto}". JSON: {"acao": "criar"|"editar", "id_ref": null|num, "valor_busca": null|float, "dados": {"tipo": "receita"|"despesa", "valor": 0.0, "descricao": "string", "categoria": "string", "data_movimentacao": "YYYY-MM-DD"}}`;

    try {
        const result = await model.generateContent(prompt);
        let text = result.response.text();
        const inicio = text.indexOf('{'), fim = text.lastIndexOf('}');
        if (inicio === -1) return null;
        return JSON.parse(text.substring(inicio, fim + 1));
    } catch (e) { return null; }
}

// --- 3. WHATSAPP COM CÓDIGO DE PAREAMENTO FORÇADO ---
wppconnect.create({
    session: 'financeiro-production-v4', // Mudei para v4 para limpar cache
    headless: true,
    logQR: false,
    
    // SEU NÚMERO FIXO (Confirme se está correto)
    phoneNumber: '557931992920',

    // FORÇA O CÓDIGO APARECER NO LOG
    catchLinkCode: (str) => {
        console.log('\n\n================ CÓDIGO DE PAREAMENTO =================');
        console.log(`CODE: ${str}`);
        console.log('=======================================================\n\n');
    },

    // IMPEDE O AUTO-CLOSE (Tempo infinito)
    autoClose: 0,
    qrTimeout: 0,

    browserArgs: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
        '--single-process', '--disable-gpu'
    ],
}).then((client) => {
    start(client);
    iniciarOuvinteDeAuth(client);
}).catch((error) => console.log(error));

// --- 4. FUNÇÕES DO BOT ---
function iniciarOuvinteDeAuth(client) {
    supabase.channel('auth-listener-bot').on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, async (payload) => {
        const novo = payload.new;
        if (novo?.auth_code && novo?.phone) {
            try {
                const check = await client.checkNumberStatus(novo.phone);
                if (check.numberExists) await client.sendText(check.id._serialized, `🔐 Código: *${novo.auth_code}*`);
            } catch (e) {}
        }
    }).subscribe();
}

function start(client) {
    console.log('✅ Bot Iniciado e Pronto!');
    client.onMessage(async (message) => {
        if (message.isGroupMsg || message.isStatus || message.from === 'status@broadcast') return;
        
        // --- 🚨 CORREÇÃO DO BUG DO LID (NUMERO GIGANTE) 🚨 ---
        // O WhatsApp às vezes manda o ID interno (@lid) em vez do telefone.
        // Aqui nós forçamos ele a pegar o número real do remetente.
        let telefoneDoUsuario = message.from;
        
        if (telefoneDoUsuario.includes('@lid')) {
            // Se veio o LID, pegamos o número real que fica escondido no objeto 'sender'
            if (message.sender && message.sender.id) {
                telefoneDoUsuario = message.sender.id; // Ex: 5579998134523@c.us
            }
        }
        // -------------------------------------------------------

        console.log(`\n🔎 RECEBI DE: ${telefoneDoUsuario}`);
        console.log(`   Texto: "${message.body}"`);

        // Usa o telefone corrigido para buscar no banco
        const usuario = await buscarUsuario(telefoneDoUsuario);
        
        if (!usuario) {
            console.log(`⛔ BLOQUEADO: O número ${telefoneDoUsuario} não está no banco.`);
            console.log(`   Normalizado tentado: ${normalizarParaComparacao(telefoneDoUsuario)}`);
            return;
        }

        console.log(`✅ USUÁRIO: ${usuario.name}`);

        // Comando !nome
        if (message.body.toLowerCase().startsWith('!nome ')) {
            const novoNome = message.body.slice(6).trim();
            await supabase.from('profiles').update({ name: novoNome }).eq('id', usuario.id);
            await client.sendText(message.from, `✅ Nome alterado.`);
            return;
        }

        const resultado = await analisarMensagem(message.body);
        
        if (!resultado) { 
            await client.sendText(message.from, "🤔 Não entendi."); 
            return; 
        }

        if (resultado.dados?.categoria) resultado.dados.categoria = padronizarCategoria(resultado.dados.categoria);

        if (resultado.acao === 'criar') {
            const { data, error } = await supabase.from('movimentacoes').insert([{ 
                ...resultado.dados, 
                user_phone: telefoneDoUsuario, // Salva o número real, não o LID
                profile_id: usuario.id 
            }]).select();
            
            if (!error) await client.sendText(message.from, `✅ Salvo! (#${data[0].id}) \n💰 R$ ${resultado.dados.valor}`);
            else console.log("Erro banco:", error);

        } else if (resultado.acao === 'editar') {
            const { error } = await supabase.from('movimentacoes').update(resultado.dados).eq('id', resultado.id_ref || 0); 
            if(!error) await client.sendText(message.from, `✏️ Editado!`);
        }
    });
}