import dotenv from 'dotenv';
dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
    console.error("❌ ERRO: Sem chave no .env");
    process.exit(1);
}

console.log("🔍 Consultando API do Google com a chave:", API_KEY.substring(0, 10) + "...");

async function checarModelos() {
    // Consulta direta na API REST (sem SDK)
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            console.error("❌ ERRO DA API:", data.error.message);
            console.log("------------------------------------------------");
            console.log("SOLUÇÃO PROVÁVEL: Você precisa ATIVAR a API nesse link:");
            console.log("👉 https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com");
        } else {
            console.log("✅ SUCESSO! Modelos disponíveis para sua chave:");
            console.log(data.models.map(m => m.name)); // Lista só os nomes
        }
    } catch (error) {
        console.error("❌ Erro de conexão:", error);
    }
}

checarModelos();