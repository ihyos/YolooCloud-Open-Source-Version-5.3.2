# CDS Network Bot - Documentação Oficial

Este projeto é um bot de Discord profissional, desenvolvido originalmente para a CDS Network (anteriormente YolooCloud). O bot oferece um sistema completo de tickets, gerenciamento de loja, integração com pagamentos (Mercado Pago e PIX), sistema de IA, moderação e muito mais.

## 🚀 Funcionalidades Principais

*   **Sistema de Tickets Avançado**:
    *   Painéis personalizáveis (Temas: GTA RP, Comunidade, Dev, etc.).
    *   Múltiplos motivos de abertura (Compras, Atrasos, Suporte).
    *   Canais privados criados automaticamente.
    *   Logs de tickets e transcripts.
*   **Loja e Pagamentos**:
    *   Criação de produtos embedados com estoque e preço.
    *   Carrinho de compras dinâmico.
    *   Geração de pagamentos via Mercado Pago (QR Code/PIX) e PIX Manual.
    *   Entrega de "Free Key" para validação de clientes VIP.
*   **Inteligência Artificial**:
    *   Canais de IA privados para membros conversarem com o bot (integração Gemini opcional).
*   **Moderação e Administração**:
    *   Sistema de limpeza de spam (`Apagar Estrago`).
    *   Broadcast de mensagens para administradores de outros servidores.
    *   Gateways de pagamento configuráveis por servidor.
*   **Utilidades**:
    *   Boas-vindas e Saída configuráveis.
    *   Auto-Role (cargos automáticos ao entrar).
    *   Editor de Embeds profissional integrado.
    *   Sistema de economia com moeda diária (CDS Coins).
    *   Hospedagem de arquivos via GoFile (comando Upload).

## 🛠️ Configuração e Instalação

### Pré-requisitos
*   Node.js (versão 16 ou superior).
*   Conta no Discord Developer Portal.

### 1. Clonar e Instalar
```bash
git clone <seu-repo>
cd <seu-repo>
npm install
```

### 2. Configuração do `.env`
Crie um arquivo `.env` na raiz do projeto e configure as seguintes variáveis:

```env
# Token do Bot Discord
DISCORD_TOKEN=seu_token_aqui

# ID do Dono do Bot (para comandos de admin global)
OWNER_ID=seu_id_de_usuario

# Webhooks para Logs (Opcionais)
FREEKEY_WEBHOOK_URL=url_webhook_freekey
SUPPORT_WEBHOOK_URL=url_webhook_suporte

# Integrações (Opcionais)
GEMINI_API_KEY=sua_key_google_ai
VERTRA_API_KEY=sua_key_cloud_provider
```

### 3. Iniciar o Bot
```bash
node .yoloocloud/index.js
```
O bot irá registrar os comandos slash automaticamente na primeira inicialização.

## 📖 Guia de Comandos

### Membros
*   `/help` - Mostra a lista de comandos.
*   `/status` - Mostra status do bot (ping, uptime).
*   `/support` - Solicita suporte rápido via DM.
*   `/daily-currency` - Coleta moeda diária (CDS Coins).
*   `/perfil` - Mostra seu perfil e saldo.
*   `/ranking` - Ranking de economia.

### Administração
*   `/say <msg>` - Bot fala no canal.
*   `/boas-vindas <canal>` - Define canal de boas-vindas.
*   `/saida-config <canal>` - Define canal de saída.
*   `/auto-role` - Configura cargos automáticos.
*   `/embed` - Abre o editor de embeds.
*   `/config-painel` - Configura o painel de tickets.
*   `/config-channel` - Define a categoria dos tickets.
*   `/config-users` - Define cargos de suporte.
*   `/criar-servidores` - Setup automático de canais/cargos.
*   `/aicloud` - Cria um canal de IA privado.

### Mensagem (Prefixo !)
*   `!tickets` - Envia o painel de tickets no canal atual.
*   `!admin` - Painel secreto de administração (apenas Owner).

## 📁 Estrutura de Arquivos
*   `.yoloocloud/index.js`: Arquivo principal contendo toda a lógica.
*   `data/`: Armazena configurações JSON de cada servidor (banco de dados local).

## 📄 Licença
Este projeto é Open Source. Sinta-se livre para modificar e distribuir.
