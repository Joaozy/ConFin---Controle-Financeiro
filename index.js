import dotenv from 'dotenv';
import wppconnect from '@wppconnect-team/wppconnect';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import http from 'http';

dotenv.config();

// --- SERVIDOR HEALTHCHECK ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('🤖 Bot Financeiro PRO Rodando');
    res.end();
});
server.listen(process.env.PORT || 8080);

// --- CONFIGURAÇÃO ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(supabaseUrl, supabaseKey);

// --- UTILITÁRIOS ---
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

// --- CÉREBRO DA IA (MODO MULTI-TRANSACIONAL) ---
async function analisarMensagem(texto) {
    // Usando o modelo mais inteligente disponível
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
    const hoje = new Date().toISOString().split('T')[0];

    const prompt = `
    Aja como um contador especialista. Hoje: ${hoje}.
    Texto do Usuário: "${texto}"
    
    TAREFA: Identificar TODAS as transações financeiras no texto.
    O usuário pode enviar várias em uma linha ou em várias linhas.
    
    Exemplos:
    Input: "gastei 10 pão 20 leite" -> Output: 2 transações.
    Input: "paguei 430 sorvete 500 carne categoria mercado" -> Output: 2 transações (ambas categoria mercado).
    
    RETORNE APENAS UM JSON VÁLIDO COM ESTA ESTRUTURA (ARRAY):
    {
        "transacoes": [
            {
                "acao": "criar" | "editar",
                "id_ref": null | numero,
                "dados": {
                    "tipo": "despesa" | "receita", 
                    "valor": 0.00, 
                    "descricao": "string", 
                    "categoria": "string", 
                    "data_movimentacao": "YYYY-MM-DD"
                }
            }
        ]
    }
    `;

    try {
        const result = await model.generateContent(prompt);
        let text = result.response.text();

        // Limpeza do JSON
        const inicio = text.indexOf('{');
        const fim = text.lastIndexOf('}');
        if (inicio === -1) return null;
        
        const jsonResponse = JSON.parse(text.substring(inicio, fim + 1));
        
        // Garante que retorna sempre um array, mesmo que vazio
        return jsonResponse.transacoes || [];

    } catch (e) { 
        console.error("Erro IA:", e);
        return []; 
    }
}

// --- WHATSAPP (MODO DISCO PERSISTENTE) ---
wppconnect.create({
    session: 'financeiro-pro',
    headless: true,
    logQR: false,
    phoneNumber: '557931992920', // SEU NÚMERO
    
    catchLinkCode: (str) => {
        console.log('\n================ CÓDIGO DE PAREAMENTO =================');
        console.log(`CODE: ${str}`);
        console.log('=======================================================\n');
    },

    // Configurações para salvar no DISCO (/var/data)
    puppeteerOptions: {
        userDataDir: '/var/data/session-pro', // <--- AQUI ESTÁ O SEGREDO DO "NUNCA DESLIGA"
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--disable-gpu']
    }
}).then((client) => {
    start(client);
    iniciarOuvinteDeAuth(client);
}).catch((error) => console.log(error));

function iniciarOuvinteDeAuth(client) {
    supabase.channel('auth-listener-bot').on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, async (payload) => {
        const novo = payload.new;
        const destino = novo.whatsapp_id || novo.phone;
        if (novo?.auth_code && destino) {
            try {
                let idEnvio = destino.includes('@') ? destino : destino + '@c.us';
                await client.sendText(idEnvio, `🔐 Código: *${novo.auth_code}*`);
            } catch (e) { console.log('Erro envio auth:', e); }
        }
    }).subscribe();
}

function start(client) {
    console.log('✅ Bot PRO Iniciado (Multi-Transação)!');
    
    client.onMessage(async (message) => {
        if (message.isGroupMsg || message.isStatus || message.from === 'status@broadcast' || message.fromMe) return;

        // --- IDENTIFICAÇÃO (LID ou Telefone) ---
        let { data: usuario } = await supabase.from('profiles').select('*').eq('whatsapp_id', message.from).single();

        if (!usuario) {
            // Lógica de Auto-Vinculação simplificada
            const textoNumeros = message.body.replace(/\D/g, '');
            if (textoNumeros.length >= 10 && textoNumeros.length <= 13) {
                const zapTentado = normalizarParaComparacao(textoNumeros);
                const { data: profiles } = await supabase.from('profiles').select('*');
                const usuarioReal = profiles ? profiles.find(p => normalizarParaComparacao(p.phone) === zapTentado) : null;

                if (usuarioReal) {
                    await supabase.from('profiles').update({ whatsapp_id: message.from }).eq('id', usuarioReal.id);
                    await client.sendText(message.from, `✅ *Vinculado!* Olá ${usuarioReal.name}.`);
                    return;
                }
            }
            if (!usuario) {
                await client.sendText(message.from, `👋 Olá! Responda com seu número cadastrado (ex: 79999887766) para vincular.`);
                return;
            }
        }

        // --- COMANDOS ESPECIAIS ---
        if (message.body.toLowerCase().startsWith('!nome ')) {
            const novoNome = message.body.slice(6).trim();
            await supabase.from('profiles').update({ name: novoNome }).eq('id', usuario.id);
            await client.sendText(message.from, `✅ Nome alterado.`);
            return;
        }

        // --- PROCESSAMENTO INTELIGENTE ---
        const transacoes = await analisarMensagem(message.body);
        
        if (!transacoes || transacoes.length === 0) {
            await client.sendText(message.from, "🤔 Não identifiquei nenhuma transação clara.");
            return;
        }

        let resumo = [];
        let totalSucesso = 0;

        // Processa item por item (Loop)
        for (const item of transacoes) {
            if (item.dados?.categoria) item.dados.categoria = padronizarCategoria(item.dados.categoria);

            if (item.acao === 'criar') {
                const { data, error } = await supabase.from('movimentacoes').insert([{ 
                    ...item.dados, 
                    user_phone: usuario.phone, 
                    profile_id: usuario.id 
                }]).select();

                if (!error && data) {
                    totalSucesso++;
                    const valorStr = parseFloat(item.dados.valor).toFixed(2).replace('.', ',');
                    // Adiciona ao resumo curto
                    resumo.push(`✅ ${item.dados.descricao}: R$ ${valorStr} (${item.dados.categoria})`);
                }
            } else if (item.acao === 'editar') {
                await supabase.from('movimentacoes').update(item.dados).eq('id', item.id_ref || 0).eq('profile_id', usuario.id);
                resumo.push(`✏️ Editado: ID ${item.id_ref}`);
                totalSucesso++;
            }
        }

        // --- RESPOSTA FINAL ---
        if (resumo.length > 0) {
            const cabecalho = transacoes.length > 1 ? `✅ *${totalSucesso} Transações Salvas!*` : `✅ *Salvo com Sucesso!*`;
            await client.sendText(message.from, `${cabecalho}\n\n${resumo.join('\n')}`);
        } else {
            await client.sendText(message.from, "❌ Houve um erro ao salvar os dados.");
        }
    });
}