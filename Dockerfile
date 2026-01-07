# MUDANÇA AQUI: Trocamos o 18 pelo 20 para satisfazer o Supabase
FROM node:20-slim

# 1. Instalar bibliotecas necessárias para o Chrome rodar
# (O Chrome precisa de várias dependências do Linux para funcionar sem tela)
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 2. Configurar pasta de trabalho
WORKDIR /usr/src/app

# 3. Copiar arquivos do projeto
COPY package*.json ./

# Instalação limpa das dependências
RUN npm install

# 4. Copiar o resto do código
COPY . .

# 5. Comando para iniciar
CMD [ "node", "index.js" ]