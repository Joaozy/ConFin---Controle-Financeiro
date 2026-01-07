import dotenv from 'dotenv';
import wppconnect from '@wppconnect-team/wppconnect';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import http from 'http';

dotenv.config();

// --- SERVIDOR FAKE (RENDER) ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('🤖 Bot Financeiro Online');
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
    let num = telefone.replace(/\D/g, ''); // Remove tudo que não é numero
    if (num.startsWith('55')) num = num.slice(2); // Tira o 55
    // Pega DDD + 8 digitos finais (ignora o 9 extra se tiver)
    if (num.length >= 10) return num.slice(0, 2) + num.slice(-8);
    return num;
}

function padronizarCategoria(texto) {
    if (!texto) return 'Outros';
    return texto.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// --- BUSCA INTELIGENTE DE USUÁRIO (O CORAÇÃO DA SOLUÇÃO) ---
async function identificarUsuario(client, messageId, messageFrom) {
    // 1. Tenta buscar direto pelo LID (se já estiver salvo no banco)
    let { data: usuarioPorLid } = await supabase
        .from('profiles')
        .select('*')
        .eq('whatsapp_id', messageFrom)
        .single();

    if (usuarioPorLid) {
        console.log(`✅ Usuário identificado pelo LID: ${usuarioPorLid.name}`);
        return usuarioPorLid;
    }

    console.log(`🔎 LID desconhecido (${messageFrom}). Iniciando investigação...`);

    // 2. Se não achou, precisamos descobrir o número real por trás desse LID
    let telefoneReal = null;

    try {
        // Pergunta ao WhatsApp quem é esse contato
        const contact = await client.getContact(messageFrom);
        
        // Tenta extrair o telefone de várias propriedades possíveis
        if (contact) {
            if (contact.id && !contact.id._serialized.includes('@lid')) {
                telefoneReal = contact.id._serialized; // Padrão
            } else if (contact.phoneNumber) {
                telefoneReal = contact.phoneNumber; // Alternativa
            } else if (contact.user) {
                telefoneReal = '55' + contact.user; // Alternativa bruta
            }
        }
    } catch (e) {
        console.log('⚠️ Erro ao consultar API do WhatsApp:', e);
    }

    if (!telefoneReal) {
        console.log('❌ Não foi possível descobrir o telefone real desse LID.');
        return null;
    }

    console.log(`🔓 Telefone real descoberto: ${telefoneReal}`);

    // 3. Busca no banco usando o telefone real descoberto
    const zapNormalizado = normalizarParaComparacao(telefoneReal);
    const { data: profiles } = await supabase.from('profiles').select('*');
    
    // Filtra no JS para garantir a normalização correta
    const usuarioReal = profiles ? profiles.find(p => normalizarParaComparacao(p.phone) === zapNormalizado) : null;

    // 4. Se achou o usuário pelo telefone, SALVA O LID para o futuro (Auto-Link)
    if (usuarioReal) {
        console.log(`🔗 Vínculo encontrado! Associando LID ${messageFrom} ao usuário ${usuarioReal.name}...`);
        await supabase
            .from('profiles')
            .update({ whatsapp_id: messageFrom }) // Salva o LID no banco
            .eq('id', usuarioReal.id);
        
        return usuarioReal;
    }

    return null;
}

// --- IA ---
async function analisarMensagem(texto) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
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

// --- WHATSAPP ---
wppconnect.create({
    session: 'financeiro-production-v6', // Sessão limpa v6
    headless: true,
    logQR: false,
    phoneNumber: '557931992920', // SEU FIXO
    catchLinkCode: (str) => {
        console.log('\n================ CÓDIGO DE PAREAMENTO =================');
        console.log(`CODE: ${str}`);
        console.log('=======================================================\n');
    },
    autoClose: 0, 
    qrTimeout: 0,
    browserArgs: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--disable-gpu'],
}).then((client) => {
    start(client);
    iniciarOuvinteDeAuth(client);
}).catch((error) => console.log(error));

function iniciarOuvinteDeAuth(client) {
    supabase.channel('auth-listener-bot').on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, async (payload) => {
        const novo = payload.new;
        // Se tiver LID salvo, usa ele. Se não, tenta o telefone (arriscado se for LID, mas tenta)
        const destino = novo.whatsapp_id || novo.phone;
        if (novo?.auth_code && destino) {
            try {
                // Tenta enviar. O checkNumberStatus ajuda a formatar
                await client.sendText(destino + (destino.includes('@') ? '' : '@c.us'), `🔐 Código: *${novo.auth_code}*`);
            } catch (e) { console.log('Erro envio auth:', e); }
        }
    }).subscribe();
}

function start(client) {
    console.log('✅ Bot Definitivo Iniciado!');
    
    client.onMessage(async (message) => {
        if (message.isGroupMsg || message.isStatus || message.from === 'status@broadcast') return;

        // --- PROCESSO DE IDENTIFICAÇÃO ROBUSTO ---
        const usuario = await identificarUsuario(client, message.id, message.from);

        if (!usuario) {
            console.log(`⛔ Usuário não encontrado no banco.`);
            return;
        }

        // --- COMANDO !NOME ---
        if (message.body.toLowerCase().startsWith('!nome ')) {
            const novoNome = message.body.slice(6).trim();
            await supabase.from('profiles').update({ name: novoNome }).eq('id', usuario.id);
            await client.sendText(message.from, `✅ Nome alterado para: *${novoNome}*`);
            return;
        }

        // --- IA E SALVAMENTO ---
        const resultado = await analisarMensagem(message.body);
        if (!resultado) { await client.sendText(message.from, "🤔 Não entendi."); return; }
        if (resultado.dados?.categoria) resultado.dados.categoria = padronizarCategoria(resultado.dados.categoria);

        if (resultado.acao === 'criar') {
            const { data, error } = await supabase.from('movimentacoes').insert([{ 
                ...resultado.dados, 
                user_phone: usuario.phone, // Salva o telefone real do cadastro
                profile_id: usuario.id 
            }]).select();
            
            if (!error && data) {
                const id = data[0].id;
                const valorFormatado = parseFloat(resultado.dados.valor).toFixed(2).replace('.', ',');
                const dataFormatada = resultado.dados.data_movimentacao.split('-').reverse().join('/');
                const msg = `✅ *Registro Salvo! (#${id})*\n\n💰 *Valor:* R$ ${valorFormatado}\n📝 *Desc:* ${resultado.dados.descricao}\n🏷️ *Cat:* ${resultado.dados.categoria}\n📅 *Data:* ${dataFormatada}`;
                await client.sendText(message.from, msg);
            }
        } else if (resultado.acao === 'editar') {
            const { error } = await supabase.from('movimentacoes').update(resultado.dados).eq('id', resultado.id_ref || 0).eq('profile_id', usuario.id); 
            if(!error) await client.sendText(message.from, `✏️ Atualizado!`);
        }
    });
}