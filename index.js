import dotenv from 'dotenv';
import wppconnect from '@wppconnect-team/wppconnect';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import http from 'http';
import path from 'path'; // Necessário para o caminho dinâmico

dotenv.config();

// --- 0. SERVIDOR FAKE (MANTÉM O RENDER ONLINE) ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('🤖 Bot Financeiro Online');
    res.end();
});
server.listen(process.env.PORT || 8080);

// --- 1. CONFIGURAÇÕES GERAIS ---
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

// --- 3. CÉREBRO DA IA ---
async function analisarMensagem(texto) {
    // Pode alterar o modelo conforme sua preferência (gemini-1.5-flash, gemini-pro, etc)
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const hoje = new Date().toISOString().split('T')[0];

    const prompt = `
    Aja como um assistente financeiro (JSON mode).
    Hoje: ${hoje}.
    Input do Usuário: "${texto}"
    
    OBJETIVO: Extrair dados para JSON.
    
    REGRAS:
    1. "Paguei 10 mercadoria" -> valor: 10, descricao: "mercadoria", tipo: "despesa".
    2. "Recebi 50 pix" -> valor: 50, descricao: "pix", tipo: "receita".
    3. Se não houver categoria, use "Outros".
    4. Data padrão: ${hoje}.
    
    FORMATO JSON:
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

        console.log('\n🧠 IA Respondeu:', text);

        const inicio = text.indexOf('{');
        const fim = text.lastIndexOf('}');
        
        if (inicio === -1 || fim === -1) return null;

        const jsonLimpo = text.substring(inicio, fim + 1);
        return JSON.parse(jsonLimpo);

    } catch (e) { 
        console.error("❌ Erro IA:", e);
        return null; 
    }
}

// --- 4. CONEXÃO WHATSAPP (BLINDADA PARA RENDER) ---

// Define um caminho único para o perfil do Chrome a cada reinício
// Isso evita o erro "Profile Locked" (Code 21)
const pastaSessaoDinamica = path.join(process.cwd(), 'sessions', `chrome-${Date.now()}`);

wppconnect.create({
    session: 'financeiro-pro-final', 
    headless: true, // Obrigatório no Render
    logQR: false,
    
    // SEU NÚMERO (Confirme se está correto: 55 + DDD + 9 + Numero)
    phoneNumber: '557931992920', 

    // Desliga cronômetros de erro para dar tempo de conectar
    autoClose: 0, 
    qrTimeout: 0,

    catchLinkCode: (str) => {
        console.log('\n================ CÓDIGO DE PAREAMENTO =================');
        console.log(`CODE: ${str}`);
        console.log('=======================================================\n');
    },

    // Força o Chrome a usar a pasta limpa que criamos
    puppeteerOptions: {
        userDataDir: pastaSessaoDinamica, 
    },

    // Argumentos vitais para Linux/Docker
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
}).catch((error) => {
    console.log("Erro fatal na inicialização:", error);
    process.exit(1); // Reinicia o processo em caso de erro grave
});

// --- 5. OUVINTE DE AUTH (CORRIGIDO PARA AMIGOS) ---
function iniciarOuvinteDeAuth(client) {
    supabase.channel('auth-listener-bot').on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, async (payload) => {
        const novo = payload.new;
        
        if (novo?.auth_code && novo?.phone) {
            console.log(`🔐 Auth solicitado para: ${novo.phone}`);
            try {
                // 1. Limpa o número (deixa só digitos)
                let telefoneLimpo = novo.phone.replace(/\D/g, '');

                // 2. Garante o DDI 55
                if (telefoneLimpo.length < 12) telefoneLimpo = '55' + telefoneLimpo;

                // 3. Verifica o ID real no WhatsApp (Resolve problema do 9º dígito)
                const check = await client.checkNumberStatus(telefoneLimpo + '@c.us');

                if (check.numberExists && check.id) {
                    await client.sendText(check.id._serialized, `🔐 Seu código: *${novo.auth_code}*`);
                    console.log(`✅ Enviado para ID oficial: ${check.id._serialized}`);
                } else {
                    // Fallback: Tenta enviar mesmo se a checagem falhar
                    await client.sendText(telefoneLimpo + '@c.us', `🔐 Seu código: *${novo.auth_code}*`);
                    console.log(`⚠️ Enviado forçado para: ${telefoneLimpo}`);
                }
            } catch (e) { console.log('Erro envio auth:', e); }
        }
    }).subscribe();
}

// --- 6. LÓGICA PRINCIPAL (AUTO-VINCULAÇÃO) ---
function start(client) {
    console.log('✅ Bot Iniciado (Modo Dinâmico vFinal)!');
    
    client.onMessage(async (message) => {
        if (message.isGroupMsg || message.isStatus || message.from === 'status@broadcast' || message.fromMe) return;

        // 1. Identificação pelo LID (WhatsApp ID)
        let { data: usuario } = await supabase
            .from('profiles')
            .select('*')
            .eq('whatsapp_id', message.from)
            .single();

        // 2. Auto-Vinculação (Se não achou o LID)
        if (!usuario) {
            const textoApenasNumeros = message.body.replace(/\D/g, '');
            // Se mandou um número de telefone, tenta vincular
            if (textoApenasNumeros.length >= 10 && textoApenasNumeros.length <= 13) {
                const zapTentado = normalizarParaComparacao(textoApenasNumeros);
                const { data: profiles } = await supabase.from('profiles').select('*');
                const usuarioReal = profiles ? profiles.find(p => normalizarParaComparacao(p.phone) === zapTentado) : null;

                if (usuarioReal) {
                    await supabase.from('profiles').update({ whatsapp_id: message.from }).eq('id', usuarioReal.id);
                    await client.sendText(message.from, `✅ *Vinculado!* Olá ${usuarioReal.name}, agora já te conheço.`);
                    return;
                } else {
                    await client.sendText(message.from, `❌ Telefone ${textoApenasNumeros} não encontrado. Cadastre-se no site primeiro.`);
                    return;
                }
            }
            await client.sendText(message.from, `👋 Olá! Não reconheci sua conta.\nResponda com seu *número de celular* cadastrado (com DDD) para vincular.\nEx: *79999887766*`);
            return;
        }

        // 3. Processamento Normal
        if (message.body.toLowerCase().startsWith('!nome ')) {
            const novoNome = message.body.slice(6).trim();
            await supabase.from('profiles').update({ name: novoNome }).eq('id', usuario.id);
            await client.sendText(message.from, `✅ Nome alterado.`);
            return;
        }

        const resultado = await analisarMensagem(message.body);
        
        if (!resultado) {
            await client.sendText(message.from, "🤔 Não entendi. Tente: 'Gastei 10 reais padaria'");
            return;
        }

        if (resultado.dados?.categoria) resultado.dados.categoria = padronizarCategoria(resultado.dados.categoria);

        if (resultado.acao === 'criar') {
            const { data, error } = await supabase.from('movimentacoes').insert([{ 
                ...resultado.dados, 
                user_phone: usuario.phone, 
                profile_id: usuario.id 
            }]).select();
            
            if (!error && data) {
                const id = data[0].id;
                const valor = parseFloat(resultado.dados.valor).toFixed(2).replace('.', ',');
                const dataMov = resultado.dados.data_movimentacao.split('-').reverse().join('/');
                const msg = `✅ *Salvo! (#${id})*\n💰 R$ ${valor}\n📝 ${resultado.dados.descricao}\n🏷️ ${resultado.dados.categoria}\n📅 ${dataMov}`;
                await client.sendText(message.from, msg);
            } else {
                await client.sendText(message.from, "❌ Erro ao salvar.");
            }
        } else if (resultado.acao === 'editar') {
            const { error } = await supabase.from('movimentacoes').update(resultado.dados).eq('id', resultado.id_ref || 0).eq('profile_id', usuario.id); 
            if(!error) await client.sendText(message.from, `✏️ Atualizado!`);
        }
    });
}