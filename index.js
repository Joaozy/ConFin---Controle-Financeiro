import dotenv from 'dotenv';
import wppconnect from '@wppconnect-team/wppconnect';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

// --- CONFIGURAÇÃO ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey || !process.env.GEMINI_API_KEY) {
    console.error("❌ ERRO: Faltam variáveis no arquivo .env");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- UTILITÁRIOS ---
function normalizarParaComparacao(telefone) {
    if (!telefone) return '';
    let num = telefone.replace(/\D/g, '');
    if (num.startsWith('55')) num = num.slice(2);
    if (num.length >= 10) return num.slice(0, 2) + num.slice(-8);
    return num;
}

// NOVO: Função que padroniza categorias (Ex: "fruta" -> "Fruta")
function padronizarCategoria(texto) {
    if (!texto) return 'Outros';
    return texto
        .toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

// --- BUSCA USUÁRIO ---
async function buscarUsuario(telefoneDoZap) {
    const { data: profiles, error } = await supabase.from('profiles').select('*');
    if (error || !profiles) return null;

    const zapNormalizado = normalizarParaComparacao(telefoneDoZap);
    return profiles.find(perfil => {
        const bancoNormalizado = normalizarParaComparacao(perfil.phone);
        return bancoNormalizado === zapNormalizado;
    });
}

// --- IA OTIMIZADA ---
async function analisarMensagem(texto) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const hoje = new Date().toISOString().split('T')[0];

    const prompt = `
    Aja como um contador. Hoje: ${hoje}. Texto: "${texto}"
    TAREFA: Classificar em CRIAR ou EDITAR.
    
    1. GATILHOS CRIAR: "gastei", "paguei", "comprei", "recebi", "pix", "transferi" ou valor solto.
    2. GATILHOS EDITAR: "mudar", "alterar", "corrigir", "editar", "era", "trocar".
    
    EXTRAÇÃO:
       - Se tiver "categoria X", "tag X" -> Categoria = X.
       - "Paguei/Gastei" -> Tipo = despesa.
       - "Recebi/Ganhei" -> Tipo = receita.
    
    SAÍDA JSON:
    {"acao": "criar"|"editar", "id_ref": null|num, "valor_busca": null|float, "dados": {"tipo": "...", "valor": 0.0, "descricao": "...", "categoria": "...", "data_movimentacao": "..."}}
    `;

    try {
        const result = await model.generateContent(prompt);
        let text = result.response.text();
        const inicio = text.indexOf('{');
        const fim = text.lastIndexOf('}');
        if (inicio === -1 || fim === -1) return null;
        return JSON.parse(text.substring(inicio, fim + 1));
    } catch (error) {
        if (error.toString().includes('429')) return { erro: "cota" };
        return null;
    }
}

// --- WHATSAPP ---
// --- CONFIGURAÇÃO DO WHATSAPP OTIMIZADA PARA NUVEM ---
wppconnect.create({
    session: 'financeiro-session',
    autoClose: 0,
    headless: true, // Sempre true em produção
    logQR: true,    // Vai mostrar o QR Code no Terminal do servidor
    // Configurações vitais para rodar no Docker/Linux
    browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', 
        '--disable-gpu'
    ],
}).then((client) => {
    start(client);
    iniciarOuvinteDeAuth(client);
});

function iniciarOuvinteDeAuth(client) {
    supabase.channel('auth-listener-bot')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, async (payload) => {
            const novo = payload.new;
            if (novo && novo.auth_code && novo.phone) {
                try {
                    const check = await client.checkNumberStatus(novo.phone);
                    if (check.numberExists) await client.sendText(check.id._serialized, `🔐 Código: *${novo.auth_code}*`);
                } catch (e) {}
            }
        }).subscribe();
}

// --- LÓGICA PRINCIPAL ---
function start(client) {
    console.log('🤖 Bot Higienizado Iniciado!');

    client.onMessage(async (message) => {
        if (message.isGroupMsg || message.isStatus || message.from === 'status@broadcast') return;

        const usuario = await buscarUsuario(message.from);
        if (!usuario) return;

        // Comando !nome
        if (message.body.toLowerCase().startsWith('!nome ')) {
            const novoNome = message.body.slice(6).trim();
            await supabase.from('profiles').update({ name: novoNome }).eq('id', usuario.id);
            await client.sendText(message.from, `✅ Nome alterado para: *${novoNome}*`);
            return;
        }

        const resultado = await analisarMensagem(message.body);

        if (resultado && resultado.erro === "cota") {
            await client.sendText(message.from, "⏳ Limite do Google atingido. Aguarde 1 min.");
            return;
        }

        if (!resultado) {
            await client.sendText(message.from, "🤔 Não entendi.");
            return;
        }

        // --- APLICANDO A LIMPEZA DE CATEGORIA ---
        if (resultado.dados && resultado.dados.categoria) {
            resultado.dados.categoria = padronizarCategoria(resultado.dados.categoria);
        }

        if (resultado.acao === 'criar') {
            const { data, error } = await supabase.from('movimentacoes').insert([{
                ...resultado.dados,
                user_phone: message.from,
                profile_id: usuario.id
            }]).select();

            if (!error && data) {
                await client.sendText(message.from, 
                    `✅ *Salvo! (#${data[0].id})* \n🏷️ ${resultado.dados.categoria}\n💰 R$ ${resultado.dados.valor}\n📝 ${resultado.dados.descricao}`
                );
            } else {
                await client.sendText(message.from, "❌ Erro ao salvar.");
            }
        } 
        else if (resultado.acao === 'editar') {
            let idParaEditar = resultado.id_ref;
            if (!idParaEditar && resultado.valor_busca) {
                const { data: ultimos } = await supabase.from('movimentacoes').select('id').eq('profile_id', usuario.id).eq('valor', resultado.valor_busca).order('created_at', { ascending: false }).limit(1);
                if (ultimos && ultimos.length > 0) idParaEditar = ultimos[0].id;
                else { await client.sendText(message.from, `❌ Não achei gasto de R$ ${resultado.valor_busca}.`); return; }
            }

            if (idParaEditar) {
                // Filtra campos vazios
                const campos = {};
                if (resultado.dados.valor) campos.valor = resultado.dados.valor;
                if (resultado.dados.categoria) campos.categoria = resultado.dados.categoria; // Já está padronizada
                if (resultado.dados.descricao) campos.descricao = resultado.dados.descricao;
                if (resultado.dados.data_movimentacao) campos.data_movimentacao = resultado.dados.data_movimentacao;

                const { error } = await supabase.from('movimentacoes').update(campos).eq('id', idParaEditar).eq('profile_id', usuario.id);
                if (!error) await client.sendText(message.from, `✏️ *Atualizado (#${idParaEditar})!*`);
                else await client.sendText(message.from, "❌ Erro ao editar.");
            }
        }
    });
}