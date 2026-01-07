import dotenv from 'dotenv';
import wppconnect from '@wppconnect-team/wppconnect';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import http from 'http';

dotenv.config();

// --- 0. SERVIDOR FAKE (PARA O RENDER NÃO DESLIGAR) ---
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
    // Pega apenas DDD + 8 ultimos digitos para evitar confusão com nono dígito
    if (num.length >= 10) return num.slice(0, 2) + num.slice(-8);
    return num;
}

function padronizarCategoria(texto) {
    if (!texto) return 'Outros';
    // Transforma "comida japonesa" em "Comida Japonesa"
    return texto.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// --- 3. IA (GEMINI 1.5 FLASH) ---
async function analisarMensagem(texto) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const hoje = new Date().toISOString().split('T')[0];

    const prompt = `
    Aja como um contador pessoal. Hoje: ${hoje}.
    Texto do usuário: "${texto}"
    
    TAREFA: Extrair dados para JSON.
    1. AÇÃO: "criar" (se for gasto/ganho novo) ou "editar" (se for correção).
    2. DADOS: valor (float), descricao (string), categoria (string), data_movimentacao (YYYY-MM-DD), tipo (despesa/receita).
    
    REGRAS:
    - "Gastei/Paguei" -> tipo: despesa.
    - "Recebi/Ganhei" -> tipo: receita.
    - Se não tiver categoria explicita, deduza pelo contexto ou use "Outros".
    
    SAÍDA JSON APENAS:
    {
        "acao": "criar" | "editar",
        "id_ref": null | numero, 
        "dados": {
            "tipo": "receita" | "despesa", 
            "valor": 0.00, 
            "descricao": "...", 
            "categoria": "...", 
            "data_movimentacao": "..."
        }
    }
    `;

    try {
        const result = await model.generateContent(prompt);
        let text = result.response.text();
        const inicio = text.indexOf('{'), fim = text.lastIndexOf('}');
        if (inicio === -1) return null;
        return JSON.parse(text.substring(inicio, fim + 1));
    } catch (e) { 
        console.error("Erro IA:", e);
        return null; 
    }
}

// --- 4. CONEXÃO WHATSAPP (PAREAMENTO) ---
wppconnect.create({
    session: 'financeiro-production-v5', // v5 para limpar cache e forçar login novo
    headless: true,
    logQR: false,
    
    // SEU NÚMERO FIXO (Confirme se é este mesmo)
    phoneNumber: '557931992920',

    // Força o código aparecer no LOG
    catchLinkCode: (str) => {
        console.log('\n\n================ CÓDIGO DE PAREAMENTO =================');
        console.log(`CODE: ${str}`);
        console.log('=======================================================\n\n');
    },

    // Configurações Anti-Queda
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

// --- 5. LÓGICA DO BOT ---

// Ouve mudanças na tabela profiles para mandar código 2FA
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

        // --- MODO DETETIVE (LID FIX) ---
        // Resolve o problema do número vir como ID criptografado
        let telefoneDoUsuario = message.from;
        let achouNumeroReal = false;

        if (message.author && !message.author.includes('@lid')) {
            telefoneDoUsuario = message.author;
            achouNumeroReal = true;
        }
        
        if (!achouNumeroReal && telefoneDoUsuario.includes('@lid')) {
            try {
                const contato = await client.getContact(message.from);
                if (contato && contato.id && !contato.id._serialized.includes('@lid')) {
                    telefoneDoUsuario = contato.id._serialized;
                }
            } catch (e) { console.log('Erro ao resolver LID:', e); }
        }

        console.log(`\n🔎 Mensagem de: ${telefoneDoUsuario} -> "${message.body}"`);

        // Busca Usuário no Banco
        const zapNormalizado = normalizarParaComparacao(telefoneDoUsuario);
        const { data: profiles } = await supabase.from('profiles').select('*');
        const usuario = profiles ? profiles.find(p => normalizarParaComparacao(p.phone) === zapNormalizado) : null;

        if (!usuario) {
            console.log(`⛔ Bloqueado. Número ${telefoneDoUsuario} (Norm: ${zapNormalizado}) não cadastrado.`);
            return;
        }

        console.log(`✅ Usuário: ${usuario.name}`);

        // Comando !nome
        if (message.body.toLowerCase().startsWith('!nome ')) {
            const novoNome = message.body.slice(6).trim();
            await supabase.from('profiles').update({ name: novoNome }).eq('id', usuario.id);
            await client.sendText(message.from, `✅ Nome alterado para: *${novoNome}*`);
            return;
        }

        // Processamento IA
        const resultado = await analisarMensagem(message.body);
        
        if (!resultado) {
            await client.sendText(message.from, "🤔 Não entendi.");
            return;
        }

        // Padronização de Categoria
        if (resultado.dados?.categoria) {
            resultado.dados.categoria = padronizarCategoria(resultado.dados.categoria);
        }

        // --- AÇÃO: CRIAR ---
        if (resultado.acao === 'criar') {
            const { data, error } = await supabase.from('movimentacoes').insert([{ 
                ...resultado.dados, 
                user_phone: telefoneDoUsuario, // Salva o número real
                profile_id: usuario.id 
            }]).select();
            
            if (!error && data) {
                // Mensagem Formatada
                const id = data[0].id;
                const valorFormatado = parseFloat(resultado.dados.valor).toFixed(2).replace('.', ',');
                const dataFormatada = resultado.dados.data_movimentacao.split('-').reverse().join('/');
                
                const msgConfirmacao = 
                    `✅ *Registro Salvo! (#${id})*\n\n` +
                    `💰 *Valor:* R$ ${valorFormatado}\n` +
                    `📝 *Desc:* ${resultado.dados.descricao}\n` +
                    `🏷️ *Cat:* ${resultado.dados.categoria}\n` +
                    `📅 *Data:* ${dataFormatada}`;

                await client.sendText(message.from, msgConfirmacao);
            } else {
                console.log("Erro ao salvar:", error);
                await client.sendText(message.from, "❌ Erro no banco de dados.");
            }
        } 
        
        // --- AÇÃO: EDITAR ---
        else if (resultado.acao === 'editar') {
            const { error } = await supabase.from('movimentacoes')
                .update(resultado.dados)
                .eq('id', resultado.id_ref || 0)
                .eq('profile_id', usuario.id); // Segurança extra
            
            if(!error) await client.sendText(message.from, `✏️ Atualizado com sucesso!`);
            else await client.sendText(message.from, "❌ Erro ao editar. Verifique o ID.");
        }
    });
}