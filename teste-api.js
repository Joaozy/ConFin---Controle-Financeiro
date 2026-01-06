import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

console.log("🔑 Testando chave:", process.env.GEMINI_API_KEY ? "Encontrada" : "NÃO ENCONTRADA");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listarModelos() {
  try {
    console.log("📡 Conectando no Google para listar modelos...");
    // Isso vai listar tudo que sua chave tem permissão de ver
    const model = genAI.getGenerativeModel({ model: "gemini-pro" }); 
    // Truque: O SDK não tem um método direto 'listModels' fácil exposto no root em versões antigas,
    // mas vamos tentar rodar uma geração simples pra ver se o erro muda.
    
    const result = await model.generateContent("Teste");
    console.log("✅ Sucesso! O modelo 'gemini-pro' funcionou.");
  } catch (error) {
    console.log("❌ Erro detalhado:");
    console.log(error.message);
    
    if (error.message.includes("API key not valid")) {
        console.log("💡 DIAGNÓSTICO: Sua chave de API é inválida/cancelada.");
    } else if (error.message.includes("Generative Language API has not been used")) {
        console.log("💡 DIAGNÓSTICO: Você precisa ATIVAR a API no console do Google Cloud.");
    } else if (error.response) {
        console.log("DADOS DO ERRO:", error.response);
    }
  }
}

listarModelos();