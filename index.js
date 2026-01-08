import dotenv from 'dotenv';
import wppconnect from '@wppconnect-team/wppconnect';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import http from 'http';

dotenv.config();

// --- 0. SERVIDOR FAKE (MANTÉM O RENDER ACORDADO) ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('🤖 Bot Financeiro Online');
    res.end();
});
server.listen(process.env.PORT || 8080);

// --- 1. CONFIGURAÇÃO GERAL ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(supabaseUrl, supabaseKey);

// --- 2. FUNÇÕES UTILITÁRIAS ---
function normalizarParaComparacao(telefone) {
    if (!telefone) return '';
    let num = telefone.replace(/\D/g, ''); // Remove tudo que não é número
    if (num.startsWith('55')) num = num.slice(2); // Remove o DDI 55
    // Pega DDD + 8 ultimos digitos (ignora o 9 extra se existir)
    if (num.length >= 10) return num.slice(0, 2) + num.slice(-8);
    return num;
}

function padronizarCategoria(texto) {
    if (!texto) return 'Outros';
    // Ex: "mercado central" vira "Mercado Central"
    return texto.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// --- 3. CÉREBRO DA IA (GEMINI 1.5 FLASH) ---
async function analisarMensagem(texto) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const hoje = new Date().toISOString().split('T')[0];

    const prompt = `
    Aja como um assistente financeiro (JSON mode).
    Hoje: ${hoje}.
    Input do Usuário: "${texto}"
    
    OBJETIVO: Extrair dados para JSON.
    
    REGRAS DE INTERPRETAÇÃO:
    1. "Paguei 10 mercadoria" -> valor: 10, descricao: "mercadoria", tipo: "despesa".
    2. "Recebi 50 pix" -> valor: 50, descricao: "pix", tipo: "receita".
    3. Se não houver categoria clara, use a descrição como categoria ou "Outros".
    4. Datas: Se não citar, use a de hoje (${hoje}).
    
    FORMATO DE RESPOSTA (JSON APENAS):
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
    `;

    try {
        const result = await model.generateContent(prompt);
        let text = result.response.text();

        // --- DEBUG: MOSTRA O QUE A IA PENSOU ---
        console.log('\n🧠 IA Respondeu:', text);

        // Limpeza agressiva para garantir JSON válido
        const inicio = text.indexOf('{');
        const fim = text.lastIndexOf('}');
        
        if (inicio === -1 || fim === -1) {
            console.log("❌ IA não retornou JSON válido.");
            return null;
        }

        const jsonLimpo = text.substring(inicio, fim + 1);
        return JSON.parse(jsonLimpo);

    } catch (e) { 
        if (e.toString().includes('429')) console.log("⚠️ ERRO DE COTA (Muitas mensagens).");
        else console.error("❌ ERRO NA IA:", e);
        return null; 
    }
}

// --- 4. CONEXÃO WHATSAPP ---

// --- 4. CONEXÃO WHATSAPP (MODO RENDER POTENTE) ---
wppconnect.create({
    session: 'financeiro-render-v11', // v11 para limpar cache corrompido
    headless: true,
    logQR: false,
    phoneNumber: '557931992920', // SEU NÚMERO
    
    catchLinkCode: (str) => {
        console.log('\n================ CÓDIGO DE PAREAMENTO =================');
        console.log(`CODE: ${str}`);
        console.log('=======================================================\n');
    },

    // AUMENTA A PACIÊNCIA DO ROBÔ
    autoClose: 0,
    qrTimeout: 0,
    
    // CONFIGURAÇÕES AVANÇADAS DO PUPPETEER
    puppeteerOptions: {
        userDataDir: './tokens/financeiro-render-v11', // Força salvar no lugar certo
        timeout: 0, // 0 = Espera infinita (nunca desiste de carregar a página)
        protocolTimeout: 0, // 0 = Nunca desiste de falar com o Chrome (RESOLVE O SEU ERRO)
        
        // Argumentos para deixar o Chrome leve no Linux
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Vital para Docker/Render
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', 
            '--disable-gpu'
        ]
    }
}).then((client) => {
    start(client);
    iniciarOuvinteDeAuth(client);
}).catch((error) => console.log(error));

// --- 5. LÓGICA PRINCIPAL ---
function start(client) {
    console.log('✅ Bot Iniciado (Modo Auto-Vinculação v8)!');
    
    client.onMessage(async (message) => {
        if (message.isGroupMsg || message.isStatus || message.from === 'status@broadcast') return;

        // --- PASSO 1: QUEM É VOCÊ? ---
        // Tenta achar o usuário pelo ID do WhatsApp (LID)
        let { data: usuario } = await supabase
            .from('profiles')
            .select('*')
            .eq('whatsapp_id', message.from)
            .single();

        // --- PASSO 2: AUTO-CADASTRO (ONBOARDING) ---
        if (!usuario) {
            console.log(`⛔ Desconhecido (LID: ${message.from}). Aguardando telefone...`);

            // Limpa a mensagem para ver se é só número
            const textoApenasNumeros = message.body.replace(/\D/g, '');
            const pareceTelefone = textoApenasNumeros.length >= 10 && textoApenasNumeros.length <= 13;

            if (pareceTelefone) {
                // Tenta achar esse telefone no banco
                const zapTentado = normalizarParaComparacao(textoApenasNumeros);
                const { data: profiles } = await supabase.from('profiles').select('*');
                const usuarioReal = profiles ? profiles.find(p => normalizarParaComparacao(p.phone) === zapTentado) : null;

                if (usuarioReal) {
                    // ACHOU! Salva o LID para não perguntar mais
                    await supabase
                        .from('profiles')
                        .update({ whatsapp_id: message.from })
                        .eq('id', usuarioReal.id);
                    
                    await client.sendText(message.from, `✅ *Vinculado!* \nOlá ${usuarioReal.name}, agora já te conheço.`);
                    return; // Para por aqui e espera a próxima mensagem de gasto
                } else {
                    await client.sendText(message.from, `❌ Telefone ${textoApenasNumeros} não encontrado. Cadastre-se no site primeiro.`);
                    return;
                }
            }

            // Mensagem de boas-vindas para desconhecidos
            await client.sendText(message.from, `👋 Olá! Não reconheci sua conta.\n\nResponda com seu *número de telemóvel* (com DDD) para eu vincular o seu cadastro.\nEx: *79999887766*`);
            return;
        }

        console.log(`✅ Usuário: ${usuario.name}`);

        // --- PASSO 3: COMANDOS E IA ---
        
        // Comando !nome
        if (message.body.toLowerCase().startsWith('!nome ')) {
            const novoNome = message.body.slice(6).trim();
            await supabase.from('profiles').update({ name: novoNome }).eq('id', usuario.id);
            await client.sendText(message.from, `✅ Nome alterado.`);
            return;
        }

        // Processa texto na IA
        const resultado = await analisarMensagem(message.body);
        
        if (!resultado) {
            await client.sendText(message.from, "🤔 Não entendi. Tente: 'Gastei 10 reais padaria'");
            return;
        }

        // Padroniza Categoria
        if (resultado.dados?.categoria) {
            resultado.dados.categoria = padronizarCategoria(resultado.dados.categoria);
        }

        // --- AÇÃO: CRIAR ---
        if (resultado.acao === 'criar') {
            const { data, error } = await supabase.from('movimentacoes').insert([{ 
                ...resultado.dados, 
                user_phone: usuario.phone, // Usa o telefone oficial
                profile_id: usuario.id 
            }]).select();
            
            if (!error && data) {
                // Monta o Recibo Bonito
                const id = data[0].id;
                const valorFormatado = parseFloat(resultado.dados.valor).toFixed(2).replace('.', ',');
                const dataFormatada = resultado.dados.data_movimentacao.split('-').reverse().join('/');
                
                const msg = `✅ *Salvo! (#${id})*\n\n💰 *Valor:* R$ ${valorFormatado}\n📝 *Desc:* ${resultado.dados.descricao}\n🏷️ *Cat:* ${resultado.dados.categoria}\n📅 *Data:* ${dataFormatada}`;
                
                await client.sendText(message.from, msg);
            } else {
                console.log("Erro banco:", error);
                await client.sendText(message.from, "❌ Erro ao salvar no banco.");
            }
        } 
        
        // --- AÇÃO: EDITAR ---
        else if (resultado.acao === 'editar') {
            const { error } = await supabase.from('movimentacoes')
                .update(resultado.dados)
                .eq('id', resultado.id_ref || 0)
                .eq('profile_id', usuario.id); 
            
            if(!error) await client.sendText(message.from, `✏️ Atualizado!`);
            else await client.sendText(message.from, "❌ Erro ao editar.");
        }
    });
}