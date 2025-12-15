// index.js
import "dotenv/config";
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionFlagsBits,
  Events,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  ChannelSelectMenuBuilder,
  ActivityType, // Importado para o status
  MessageFlags,
} from "discord.js";
import { AttachmentBuilder } from "discord.js";
let createCanvas, loadImage; try { const mod = await import("@napi-rs/canvas"); ({ createCanvas, loadImage } = mod); } catch { createCanvas = null; loadImage = null; }
import { QrCodePix } from "qrcode-pix";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("ERRO: defina DISCORD_TOKEN no arquivo .env");
  process.exit(1);
}

// Gemini AI Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const text = "Informamos que a integração com gemini não está disponível atualmente"
// Função para obter o modelo do Gemini
async function getGeminiResponse(userMessage) {
  try {
    // Tenta usar gemini-1.5-flash (mais rápido e gratuito)
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(userMessage);
    return result.response.text();
  } catch (err) {
    console.error("[AI] Erro com gemini-1.5-flash, tentando gemini-pro:", err.message);
    // Fallback para gemini-pro
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent(userMessage);
    return result.response.text();
  }
}

// Armazena os canais de IA privados
const aiChannels = new Set();
// Armazena os canais de upload privados
const uploadChannels = new Set();
// Telemetria simples de uso de comandos (em memória)
const commandUsage = new Map();
function trackCommandUsage(commandName) {
  try {
    const key = String(commandName || 'unknown').toLowerCase();
    commandUsage.set(key, (commandUsage.get(key) || 0) + 1);
  } catch { }
}

// Helper: garantir cargo fixo "CDS Network Bot" com cor e permissões
async function ensureBotRole(guild) {
  try {
    const roleName = "CDS Network Bot";
    let role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) {
      role = await guild.roles.create({
        name: roleName,
        color: DEFAULT_COLOR,
        permissions: [PermissionFlagsBits.Administrator],
        reason: "Criando cargo fixo do Yoloo Cloud Bot"
      });
    } else {
      // Garante permissões e cor
      const needsUpdate = !role.permissions.has(PermissionFlagsBits.Administrator) || role.color !== DEFAULT_COLOR;
      if (needsUpdate) {
        await role.setPermissions([PermissionFlagsBits.Administrator]).catch(() => { });
        await role.setColor(DEFAULT_COLOR).catch(() => { });
      }
    }
    // Posiciona o cargo o mais alto possível (se permitido)
    try {
      const highest = guild.roles.highest;
      if (highest && role.position < highest.position) {
        await role.setPosition(highest.position).catch(() => { });
      }
    } catch { }
    // Atribui ao bot
    try {
      const me = guild.members.me || (await guild.members.fetchMe());
      if (me && !me.roles.cache.has(role.id)) {
        await me.roles.add(role, "Garantindo cargo do bot").catch(() => { });
      }
    } catch { }
  } catch (e) {
    console.warn("[BotRole] Falha ao garantir cargo do bot:", e?.message || e);
  }
}

// Estado temporário para confirmações do painel admin
const pendingAdminRemovals = new Map(); // key: userId, value: { type, id }

const START_TIME = new Date(); // Captura o tempo de início do bot

// Helper para assinatura simples do código atual (usado para detectar commits/atualizações)
function computeCodeSignature() {
  try {
    const filePath = path.resolve(__filename);
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const mtimeMs = stat.mtimeMs;
    return `${size}:${Math.floor(mtimeMs)}`;
  } catch (e) {
    return null;
  }
}

// Helper para gerar tag de emoji custom resolvendo por ID (com fallback)
function resolveEmojiTagById(id, fallbackText, fallbackName = "emoji") {
  try {
    // Procura o emoji em qualquer guild do bot
    for (const [, guild] of client.guilds.cache) {
      const emoji = guild.emojis?.cache?.get?.(id);
      if (emoji) {
        return emoji.toString(); // <a:name:id> ou <:name:id>
      }
    }
    // Se não encontrou, retorna tag padrão (pode renderizar se o bot tiver acesso ao emoji de origem)
    return `<:${fallbackName}:${id}>`;
  } catch {
    return fallbackText || `:${fallbackName}:`;
  }
}

async function sendStatusLogToConfiguredGuilds({ title, description, color = DEFAULT_COLOR, fields = [] }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .addFields(fields)
    .setTimestamp();

  for (const [guildId, cfg] of Object.entries(guildConfigs)) {
    const channelId = cfg.statusLogChannelId;
    if (!channelId) continue;
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch && ch.type === ChannelType.GuildText) {
        await ch.send({ embeds: [embed] });
      }
    } catch (e) {
      // ignora erros por guild sem acesso
    }
  }
}

function setupShutdownNotifiers() {
  const notify = async (reason) => {
    try {
      const uptimeSec = Math.floor((Date.now() - START_TIME.getTime()) / 1000);
      await sendStatusLogToConfiguredGuilds({
        title: "🟥 Bot Offline",
        description: `O bot está desligando agora (${reason}).`,
        color: 0xff0000,
        fields: [
          { name: "Uptime", value: `${uptimeSec}s`, inline: true },
        ],
      });
    } catch { }
  };

  const handler = (sig) => {
    notify(sig).finally(() => {
      // Encerra após pequena espera para tentar enviar as mensagens
      setTimeout(() => process.exit(0), 1000);
    });
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  process.on('beforeExit', () => notify('beforeExit'));
  process.on('uncaughtException', (err) => {
    notify('uncaughtException').finally(() => {
      console.error(err);
      setTimeout(() => process.exit(1), 500);
    });
  });
  process.on('unhandledRejection', (err) => {
    notify('unhandledRejection');
    console.error(err);
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, // Necessário para os eventos de Boas-Vindas e Saída
  ],
  partials: [Partials.Channel],
});

const serverCreationState = new Map();

const CONFIG_FILE = path.resolve("./data/guild_configs.json");
const THUMBNAIL_FALLBACK = "";
const DEFAULT_COLOR = 0x32cd32; // Verde Lima
// Vertra Cloud defaults (podem ser configurados por guild via painel admin)
const VERTRA_BASE_URL_DEFAULT = process.env.VERTRA_BASE_URL || "https://api.vertra.cloud";
const VERTRA_API_KEY_DEFAULT = process.env.VERTRA_API_KEY || "";

// Webhook URL fornecida por você
const FREEKEY_WEBHOOK_URL = process.env.FREEKEY_WEBHOOK_URL;

// (NOVO) Webhook do /yoloosupport
const SUPPORT_WEBHOOK_URL = process.env.SUPPORT_WEBHOOK_URL;


// Mapeamento de nomes de emojis para IDs (para config avançada)
const EMOJI_MAP = {
  pix: "",
  package1: "",
  sino: "",
  star: "",
  greenMark: "",
  aviso: "",
  agenda: "",
  archive: "",
  block: "",
  bot: "",
  chat: "",
  config: "",
  cor: "",
  correct: "",
  delete: "",
  email: "",
  error: "",
  pincel: "",
  ir: "",
  voltar: "",
  restart: "",
  save: "",
  gift1: "",
  ticket1: "",
  user: "",
};

const DATA_DIR = path.resolve("./data");
const USERS_DB_FILE = path.join(DATA_DIR, "users.json");
const DAILY_EMOJI_ID = "";
const YC_AMOUNT = 1500;
const FAIL_LOG_FILE = path.join(DATA_DIR, "failures.json");
const AUTO_ROLE_LOG_FILE = path.join(DATA_DIR, "auto_roles.json");
const WELCOME_LOG_FILE = path.join(DATA_DIR, "welcome.json");
const LEAVE_LOG_FILE = path.join(DATA_DIR, "leave.json");
const CONFIG_CHANNEL_LOG_FILE = path.join(DATA_DIR, "config_channel.json");
const CONFIG_USERS_LOG_FILE = path.join(DATA_DIR, "config_users.json");
const CONFIG_PAINEL_LOG_FILE = path.join(DATA_DIR, "config_painel.json");
const RANKING_FILE = path.join(DATA_DIR, "ranking.json");

function ensureUsersDb() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(USERS_DB_FILE)) fs.writeFileSync(USERS_DB_FILE, JSON.stringify({}, null, 2));
    if (!fs.existsSync(FAIL_LOG_FILE)) fs.writeFileSync(FAIL_LOG_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(AUTO_ROLE_LOG_FILE)) fs.writeFileSync(AUTO_ROLE_LOG_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(WELCOME_LOG_FILE)) fs.writeFileSync(WELCOME_LOG_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(LEAVE_LOG_FILE)) fs.writeFileSync(LEAVE_LOG_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(CONFIG_CHANNEL_LOG_FILE)) fs.writeFileSync(CONFIG_CHANNEL_LOG_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(CONFIG_USERS_LOG_FILE)) fs.writeFileSync(CONFIG_USERS_LOG_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(CONFIG_PAINEL_LOG_FILE)) fs.writeFileSync(CONFIG_PAINEL_LOG_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(RANKING_FILE)) fs.writeFileSync(RANKING_FILE, JSON.stringify([], null, 2));
  } catch { }
}

function loadUsersDb() {
  ensureUsersDb();
  try {
    const raw = fs.readFileSync(USERS_DB_FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    if (data && typeof data === "object") return data;
    return {};
  } catch {
    return {};
  }
}

function saveUsersDb(db) {
  try {
    const tmp = USERS_DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, USERS_DB_FILE);
  } catch { }
}

function saveRanking(list) {
  try {
    const tmp = RANKING_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, RANKING_FILE);
  } catch { }
}

function appendJsonArray(filePath, entry) {
  try {
    ensureUsersDb();
    const raw = fs.readFileSync(filePath, "utf8");
    const arr = JSON.parse(raw || "[]");
    if (Array.isArray(arr)) {
      arr.push(entry);
      const tmp = filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
      fs.renameSync(tmp, filePath);
    }
  } catch { }
}

function logFailure(commandName, userId, guildId, reason, extra = {}) {
  const entry = { command: commandName, userId, guildId, reason, extra, timestamp: new Date().toISOString() };
  appendJsonArray(FAIL_LOG_FILE, entry);
}

function getUserRecord(db, userId) {
  if (!db[userId]) db[userId] = { userId, balance: 0, lastClaimAt: null, claims: [] };
  return db[userId];
}

function millisUntilNextClaim(lastClaimAt) {
  if (!lastClaimAt) return 0;
  const next = new Date(lastClaimAt).getTime() + 24 * 60 * 60 * 1000;
  return Math.max(0, next - Date.now());
}

function formatDurationPt(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m ${r}s`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

async function buildInfoImage(user, balance) {
  if (!createCanvas || !loadImage) throw new Error("canvas_unavailable");
  const width = 900;
  const height = 360;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  let bannerImg = null;
  let accent = "#5865F2";
  try {
    const fetched = await client.users.fetch(user.id, { force: true });
    const bannerUrl = fetched.bannerURL({ size: 1024, extension: "png" });
    if (fetched.hexAccentColor) accent = fetched.hexAccentColor;
    if (bannerUrl) bannerImg = await loadImage(bannerUrl);
  } catch { }
  if (bannerImg) {
    ctx.drawImage(bannerImg, 0, 0, width, 180);
  } else {
    const grad = ctx.createLinearGradient(0, 0, width, 180);
    grad.addColorStop(0, accent);
    grad.addColorStop(1, "#2C2F33");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, 180);
  }
  ctx.fillStyle = "#23272A";
  ctx.fillRect(0, 180, width, height - 180);
  const avatarUrl = user.displayAvatarURL({ extension: "png", size: 256 });
  let avSize = 140;
  let avX = 30;
  let avY = 40;
  try {
    const avatarImg = await loadImage(avatarUrl);
    ctx.save();
    ctx.beginPath();
    ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatarImg, avX, avY, avSize, avSize);
    ctx.restore();
  } catch { }
  ctx.fillStyle = "#3BA55D";
  ctx.beginPath();
  ctx.arc(avX + avSize - 18, avY + avSize - 18, 12, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 28px Arial";
  ctx.fillText(user.username, avX + avSize + 20, 210);
  ctx.fillStyle = "#99AAB5";
  ctx.font = "20px Arial";
  ctx.fillText("Perfil CDS Network", avX + avSize + 20, 240);
  let emojiImg = null;
  try {
    const f = await ensureFetch();
    const emojiRes = await f(`https://cdn.discordapp.com/emojis/${DAILY_EMOJI_ID}.png?size=128&quality=lossless`);
    if (emojiRes.ok) {
      const buf = Buffer.from(await emojiRes.arrayBuffer());
      emojiImg = await loadImage(buf);
    }
  } catch { }
  const bannerH = 180;
  const pad = 16;
  const fontSize = Math.max(24, Math.min(48, Math.round(width * 0.045)));
  ctx.font = `bold ${fontSize}px Arial`;
  const text = `${balance} CDS`;
  const textW = ctx.measureText(text).width;
  const iconSize = Math.round(fontSize * 0.9);
  const gap = 10;
  const totalW = (emojiImg ? iconSize : 0) + (emojiImg ? gap : 0) + textW;
  const boxW = totalW + 20;
  const boxH = iconSize + 20;
  const boxX = width - pad - boxW;
  const boxY = pad;
  const rr = 12;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(boxX + rr, boxY);
  ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, rr);
  ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, rr);
  ctx.arcTo(boxX, boxY + boxH, boxX, boxY, rr);
  ctx.arcTo(boxX, boxY, boxX + boxW, boxY, rr);
  ctx.closePath();
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fill();
  ctx.restore();
  if (emojiImg) ctx.drawImage(emojiImg, boxX + 10, boxY + (boxH - iconSize) / 2, iconSize, iconSize);
  ctx.fillStyle = "#FFFFFF";
  ctx.textBaseline = "middle";
  const textX = boxX + 10 + (emojiImg ? iconSize + gap : 0);
  const textY = boxY + boxH / 2;
  ctx.fillText(text, textX, textY);
  return canvas.toBuffer("image/png");
}

// helper para garantir fetch (suporte Node <18 via undici se necessário)
let _fetch = globalThis.fetch;
async function ensureFetch() {
  if (typeof _fetch !== "function") {
    try {
      // tenta importar undici dinamicamente
      const undici = await import("undici");
      _fetch = undici.fetch;
    } catch (e) {
      console.warn(
        "fetch não disponível e undici não instalado. Instale undici (npm i undici) se ocorrer erro ao postar webhook."
      );
      throw e;
    }
  }
  return _fetch;
}

// --- helpers for config persistence ---
function loadConfigs() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8") || "{}");
  } catch (err) {
    console.error("Erro ao ler configs:", err);
    return {};
  }
}
function saveConfigs(cfg) {
  return;
}
let guildConfigs = loadConfigs();

// default panel template
function defaultPanel() {
  return {
    title: "Support Yoloo Cloud",
    description: "Abra um ticket selecionando a opção abaixo.",
    color: DEFAULT_COLOR,
    bannerURL: null,
    thumbnailURL: null,
    footerText: "Powered By Yoloo Cloud",
    footerIcon: null,
    // --- NOVOS CAMPOS PARA PAINEL AVANÇADO ---
    panelType: "default", // "default" (select) ou "simple" (button)
    advancedConfig: false, // true ou false
    simpleButtonLabel: "Abrir Ticket", // Texto do botão no modo simple
    options: [
      // Opções padrão do select
      {
        label: "Problemas com minha compra",
        description: "Cobrança, PIX, entrega",
        value: "compra",
        emoji: "pix", // Nome do emoji (chave do EMOJI_MAP)
      },
      {
        label: "Meu Produto não chegou",
        description: "Atraso / extravio",
        value: "atraso",
        emoji: "package1",
      },
      {
        label: "Preciso de ajuda!",
        description: "Suporte geral",
        value: "ajuda",
        emoji: "sino",
      },
    ],
  };
}

// (NOVO) Templates de painéis pré-definidos por tema
function getPanelTemplate(themeName, guildName, guildIcon) {
  const EMOJIS_THEME = {
    gta: { id: "", name: "🎮" },
    community: { id: "", name: "👥" },
    friends: { id: "", name: "🤝" },
    dev: { id: "", name: "💻" },
  };

  const templates = {
    gta: {
      title: `🎮 ${guildName} - Suporte`,
      description: "Abrir ticket de suporte para problemas, denúncias ou sugestões.",
      color: 0xFF6B6B,
      bannerURL: null,
      thumbnailURL: guildIcon,
      footerText: `${guildName} - Sistema de Tickets`,
      footerIcon: guildIcon,
      panelType: "default",
      advancedConfig: false,
      simpleButtonLabel: "Abrir Ticket",
      options: [
        { label: "🚗 Reportar Bug/Sugestão", description: "Problemas técnicos ou melhorias", value: "bug", emoji: "bug" },
        { label: "🛡️ Reportar Jogador", description: "Denunciar comportamento inadequado", value: "denuncia", emoji: "shield" },
        { label: "💬 Outros Assuntos", description: "Dúvidas gerais sobre o servidor", value: "geral", emoji: "chat" },
      ],
    },
    community: {
      title: `👥 ${guildName} - Central de Ajuda`,
      description: "Selecione o motivo do seu atendimento abaixo.",
      color: 0x4A90E2,
      bannerURL: null,
      thumbnailURL: guildIcon,
      footerText: `${guildName} © Todos os direitos reservados`,
      footerIcon: guildIcon,
      panelType: "default",
      advancedConfig: false,
      simpleButtonLabel: "Solicitar Ajuda",
      options: [
        { label: "❓ Dúvidas Gerais", description: "Perguntas sobre regras e comandos", value: "duvidas", emoji: "question" },
        { label: "🎯 Aplicar para Cargo", description: "Candidatura para cargos especiais", value: "cargo", emoji: "medal" },
        { label: "📢 Suporte Técnico", description: "Problemas com bots ou configurações", value: "tecnico", emoji: "wrench" },
      ],
    },
    friends: {
      title: `🤝 ${guildName} - Suporte aos Amigos`,
      description: "Precisa de ajuda? Abra um ticket e nossa equipe irá te atender!",
      color: 0x32CD32,
      bannerURL: null,
      thumbnailURL: guildIcon,
      footerText: `${guildName} - Feito com ❤️`,
      footerIcon: guildIcon,
      panelType: "default",
      advancedConfig: false,
      simpleButtonLabel: "Preciso de Ajuda",
      options: [
        { label: "💬 Chat e Conversação", description: "Dúvidas sobre conversas e canais", value: "chat", emoji: "chat" },
        { label: "🎮 Atividades", description: "Sugestões e feedback sobre eventos", value: "atividades", emoji: "game" },
        { label: "❤️ Elogios e Feedback", description: "Compartilhe sua opinião conosco", value: "feedback", emoji: "heart" },
      ],
    },
    dev: {
      title: `💻 ${guildName} - Suporte Dev`,
      description: "Sistema de tickets para desenvolvedores e programadores.",
      color: 0x7289DA,
      bannerURL: null,
      thumbnailURL: guildIcon,
      footerText: `${guildName} - Powered by Yoloo Cloud`,
      footerIcon: guildIcon,
      panelType: "default",
      advancedConfig: false,
      simpleButtonLabel: "Abrir Ticket Dev",
      options: [
        { label: "🐛 Reportar Bug", description: "Erros encontrados no código", value: "bug", emoji: "bug" },
        { label: "💡 Sugestão de Feature", description: "Ideias para melhorias", value: "feature", emoji: "bulb" },
        { label: "🤝 Colaboração", description: "Quer contribuir com o projeto?", value: "collab", emoji: "handshake" },
      ],
    },
  };

  return templates[themeName] || defaultPanel();
}

// default embed template for /embed command
function defaultEmbed() {
  return {
    title: "Embed de Exemplo",
    description: "Use os botões para editar o conteúdo desta embed.",
    color: DEFAULT_COLOR,
    imageURL: null,
    thumbnailURL: null,
    footerText: "Editor de Embed",
    footerIcon: null,
    fields: [],
  };
}

// (NOVO) default product template for !criarproduto command
function defaultProduct() {
  return {
    title: "Insira o nome do produto aqui",
    description: "Insira a descrição do produto aqui",
    color: DEFAULT_COLOR,
    price: 9.99,
    stock: -1, // -1 para infinito
    bannerURL: null,
    thumbnailURL: null,
    footerText: "Powered By Yoloo Cloud, CDS Network inc. © Todos os direitos reservados",
    footerIcon: null,
  };
}

function loadJsonArraySafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function latestByGuild(filePath, guildId) {
  const arr = loadJsonArraySafe(filePath);
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]?.guildId === guildId) return arr[i];
  }
  return null;
}

function latestPanelForGuild(guildId) {
  const last = latestByGuild(CONFIG_PAINEL_LOG_FILE, guildId);
  return last?.panel || null;
}

// ensure config exists for guild
function ensureGuildConfig(guildId) {
  if (!guildConfigs[guildId]) {
    const cfg = {
      supportRoles: [],
      autoRoles: [],
      categoryId: null,
      panel: defaultPanel(),
      welcomeChannelId: null,
      leaveChannelId: null,
      statusLogChannelId: null,
      tempEmbed: defaultEmbed(),
      tempEmbedMessageId: null,
      tempEmbedChannelId: null,
      paymentConfig: { enabled: false, mpToken: null, pixType: null, pixKey: null, pixMode: "text" },
      products: {},
      tempProduct: defaultProduct(),
      tempPixType: null,
      tempPixMode: null,
      tempProductMessageId: null,
      tempProductChannelId: null,
      lastCodeSignature: null,
      lastStartTime: null,
      language: "br",
      tempLanguage: null,
      vertraConfig: { baseUrl: VERTRA_BASE_URL_DEFAULT, apiKey: VERTRA_API_KEY_DEFAULT, serviceId: null },
    };
    const p = latestPanelForGuild(guildId);
    if (p) cfg.panel = { ...defaultPanel(), ...p };
    const cat = latestByGuild(CONFIG_CHANNEL_LOG_FILE, guildId);
    if (cat?.channelId) cfg.categoryId = cat.channelId;
    const sup = latestByGuild(CONFIG_USERS_LOG_FILE, guildId);
    if (Array.isArray(sup?.roles)) cfg.supportRoles = sup.roles;
    const ar = latestByGuild(AUTO_ROLE_LOG_FILE, guildId);
    if (Array.isArray(ar?.roles)) cfg.autoRoles = ar.roles;
    const wel = latestByGuild(WELCOME_LOG_FILE, guildId);
    if (wel?.channelId) cfg.welcomeChannelId = wel.channelId;
    const lea = latestByGuild(LEAVE_LOG_FILE, guildId);
    if (lea?.channelId) cfg.leaveChannelId = lea.channelId;
    guildConfigs[guildId] = cfg;
  } else {
    const panel = guildConfigs[guildId].panel || defaultPanel();
    if (panel.panelType === undefined) panel.panelType = "default";
    if (panel.advancedConfig === undefined) panel.advancedConfig = false;
    if (panel.simpleButtonLabel === undefined) panel.simpleButtonLabel = "Abrir Ticket";
    if (panel.options === undefined) panel.options = defaultPanel().options;
    guildConfigs[guildId].panel = panel;
  }
  return guildConfigs[guildId];
}

// helper to create a ticket channel with proper overwrite
async function createTicketChannel(guild, user, shortLabel, guildCfg) {
  const name = `${user.username
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12)}-${shortLabel}`;
  // ensure category exists
  const category = guild.channels.cache.get(guildCfg.categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new Error("Categoria de tickets não configurada ou inválida.");
  }

  // build permission overwrites
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  // add support roles
  for (const roleId of guildCfg.supportRoles || []) {
    const role = guild.roles.cache.get(roleId);
    if (role) {
      overwrites.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }
  }

  // also add members with admin perms (server admins) automatically
  // iterate guild members cache; if not cached, rely on role config for access
  guild.members.cache.forEach((m) => {
    if (m.permissions.has(PermissionFlagsBits.Administrator) && !m.user.bot) {
      overwrites.push({
        id: m.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }
  });

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites,
    reason: `Ticket aberto por ${user.tag}`,
  });
  return channel;
}

// (NOVO) Helper para criar canal de carrinho
async function createCartChannel(guild, user, product, guildCfg, currentCategory) {
  const name = `🛒-${user.username
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 15)}`;

  // Tenta usar a categoria atual do produto, se falhar, usa a categoria de ticket
  let parentCategory = currentCategory;
  if (!parentCategory || parentCategory.type !== ChannelType.GuildCategory) {
    parentCategory = guild.channels.cache.get(guildCfg.categoryId);
  }

  if (!parentCategory || parentCategory.type !== ChannelType.GuildCategory) {
    throw new Error("Categoria de tickets/carrinhos não configurada ou inválida.");
  }

  // Overwrites (igual ao ticket)
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
  for (const roleId of guildCfg.supportRoles || []) {
    if (guild.roles.cache.has(roleId)) {
      overwrites.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }
  }
  guild.members.cache.forEach((m) => {
    if (m.permissions.has(PermissionFlagsBits.Administrator) && !m.user.bot) {
      overwrites.push({
        id: m.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }
  });

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentCategory.id,
    permissionOverwrites: overwrites,
    reason: `Carrinho aberto por ${user.tag} para ${product.title}`,
  });
  return channel;
}

async function createServerStructure(guild, theme, storeTheme, user) {
  const roles = {};
  roles.membros = await guild.roles.create({ name: "Membros", color: 0x808080, reason: "Setup" });
  roles.clientes = await guild.roles.create({ name: "Clientes", color: 0x3BA55D, reason: "Setup" });
  roles.admin = await guild.roles.create({ name: "Admin", color: 0xED4245, reason: "Setup" });
  if (theme === "dev") {
    roles.dev = await guild.roles.create({ name: "Desenvolvedor", color: 0x5865F2, reason: "Setup" });
  }
  const catGeral = await guild.channels.create({ name: "GERAL", type: ChannelType.GuildCategory, reason: "Setup" });
  const catLoja = await guild.channels.create({ name: "LOJA", type: ChannelType.GuildCategory, reason: "Setup" });
  const catSuporte = await guild.channels.create({ name: "SUPORTE", type: ChannelType.GuildCategory, reason: "Setup" });
  const chRegras = await guild.channels.create({ name: "📜-regras", type: ChannelType.GuildText, parent: catGeral.id, reason: "Setup" });
  const chAnuncios = await guild.channels.create({ name: "📣-anuncios", type: ChannelType.GuildText, parent: catGeral.id, reason: "Setup" });
  const chChat = await guild.channels.create({ name: "💬-chat-geral", type: ChannelType.GuildText, parent: catGeral.id, reason: "Setup" });
  const chVitrine = await guild.channels.create({ name: "🛍️-vitrine", type: ChannelType.GuildText, parent: catLoja.id, reason: "Setup" });
  const chCompras = await guild.channels.create({ name: "🛒-compras", type: ChannelType.GuildText, parent: catLoja.id, reason: "Setup" });
  const chReviews = await guild.channels.create({ name: "⭐-reviews", type: ChannelType.GuildText, parent: catLoja.id, reason: "Setup" });
  const chTicket = await guild.channels.create({ name: "🎫-abrir-ticket", type: ChannelType.GuildText, parent: catSuporte.id, reason: "Setup" });
  const guildCfg = ensureGuildConfig(guild.id);
  guildCfg.categoryId = catSuporte.id;
  saveConfigs(guildConfigs);
  const panel = guildCfg.panel || defaultPanel();
  const embed = buildPanelEmbed(guildCfg);
  const options = (panel.options || []).map(opt => {
    const emojiId = EMOJI_MAP[opt.emoji];
    return { label: opt.label, description: opt.description, value: opt.value, emoji: emojiId ? { id: emojiId, name: opt.emoji } : undefined };
  });
  const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("ticket-select").setPlaceholder("Selecione o motivo do seu ticket...").addOptions(options));
  await chTicket.send({ embeds: [embed], components: [row] });
  const everyone = guild.roles.everyone;
  const privateChannel = await guild.channels.create({
    name: `setup-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10)}`,
    type: ChannelType.GuildText,
    parent: catSuporte.id,
    permissionOverwrites: [
      { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ],
    reason: "Setup"
  });
  return { roles, categories: { catGeral, catLoja, catSuporte }, channels: { chRegras, chAnuncios, chChat, chVitrine, chCompras, chReviews, chTicket }, privateChannel };
}

async function cleanSpamAcrossGuilds() {
  const banned = [
    "porra", "pilantra", "vagabundo", "fudidao", "cu", "vagabondo", "rabao", "nude", "lingerie", "fudendo", "gozando", "pica", "sexo", "gostosa", "caralho", "bunda", "fuder", "tesao"
  ];
  let messagesRemoved = 0;
  let channelsRemoved = 0;
  let errors = 0;
  for (const g of client.guilds.cache.values()) {
    try {
      await g.channels.fetch();
      for (const ch of g.channels.cache.values()) {
        try {
          const name = (ch.name || "").toLowerCase();
          if (banned.some(w => name.includes(w))) {
            await ch.delete("Apagar Estrago");
            channelsRemoved++;
            continue;
          }
          if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
            let lastId = undefined;
            for (let i = 0; i < 5; i++) {
              const batch = await ch.messages.fetch({ limit: 100, before: lastId }).catch(() => null);
              if (!batch || batch.size === 0) break;
              for (const m of batch.values()) {
                const content = (m.content || "").toLowerCase();
                if (content.includes("@everyone foda se!!")) {
                  await m.delete().catch(() => { });
                  messagesRemoved++;
                }
              }
              lastId = batch.last()?.id;
              if (!lastId) break;
            }
          }
        } catch { errors++; }
      }
    } catch { errors++; }
  }
  return { messagesRemoved, channelsRemoved, errors };
}


// função para postar no webhook (JSON)
async function postToWebhook(url, payload) {
  try {
    const f = await ensureFetch();
    const res = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("Falha ao postar webhook:", res.status, txt);
      return { ok: false, status: res.status, text: txt };
    }
    return { ok: true };
  } catch (err) {
    console.error("Erro ao postar webhook:", err);
    return { ok: false, error: err.message || err };
  }
}

// --- Vertra Cloud API helper ---
async function callVertraService(action, guildCfg) {
  try {
    const f = await ensureFetch();
    const cfg = guildCfg?.vertraConfig || {};
    const baseUrl = (cfg.baseUrl || VERTRA_BASE_URL_DEFAULT).replace(/\/$/, "");
    const apiKey = cfg.apiKey || VERTRA_API_KEY_DEFAULT;
    const serviceId = cfg.serviceId;
    if (!serviceId) {
      return { ok: false, error: "Service ID não configurado." };
    }
    const url = `${baseUrl}/services/${encodeURIComponent(serviceId)}/${encodeURIComponent(action)}`;
    const res = await f(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ source: "yoloo-cloud-bot" }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, status: res.status, text: txt };
    }
    let data = null;
    try { data = await res.json(); } catch { }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// --- Gofile API helper ---
async function uploadToGofile(fileBuffer, fileName) {
  try {
    const f = await ensureFetch();

    // 1. Obter servidor otimizado
    const serverRes = await f("https://api.gofile.io/servers");
    if (!serverRes.ok) {
      return { ok: false, error: "Falha ao obter servidor Gofile." };
    }
    const serverData = await serverRes.json();
    const server = serverData.data?.servers?.[0]?.server;
    if (!server) {
      return { ok: false, error: "Servidor Gofile não disponível." };
    }

    // 2. Upload do arquivo usando FormData compatível com Node.js
    let FormData;
    try {
      FormData = (await import("form-data")).default;
    } catch {
      // Fallback: usar fetch com FormData global se disponível
      const formData = new FormData();
      formData.append("file", new Blob([fileBuffer]), fileName);
      const uploadRes = await f(`https://${server}.gofile.io/contents/uploadFile`, {
        method: "POST",
        body: formData,
      });
      if (!uploadRes.ok) {
        const txt = await uploadRes.text().catch(() => "");
        return { ok: false, error: `Upload falhou: ${uploadRes.status} ${txt}` };
      }
      const uploadData = await uploadRes.json();
      if (uploadData.status !== "ok") {
        return { ok: false, error: uploadData.status || "Upload falhou." };
      }
      const fileId = uploadData.data?.fileId;
      const downloadPage = uploadData.data?.downloadPage;
      if (!fileId || !downloadPage) {
        return { ok: false, error: "Resposta do Gofile inválida." };
      }
      return { ok: true, url: downloadPage, fileId };
    }

    // Usar form-data (Node.js)
    const formData = new FormData();
    formData.append("file", fileBuffer, fileName);

    const uploadRes = await f(`https://${server}.gofile.io/contents/uploadFile`, {
      method: "POST",
      body: formData,
      headers: formData.getHeaders ? formData.getHeaders() : {},
    });

    if (!uploadRes.ok) {
      const txt = await uploadRes.text().catch(() => "");
      return { ok: false, error: `Upload falhou: ${uploadRes.status} ${txt}` };
    }

    const uploadData = await uploadRes.json();
    if (uploadData.status !== "ok") {
      return { ok: false, error: uploadData.status || "Upload falhou." };
    }

    const fileId = uploadData.data?.fileId;
    const downloadPage = uploadData.data?.downloadPage;

    if (!fileId || !downloadPage) {
      return { ok: false, error: "Resposta do Gofile inválida." };
    }

    return { ok: true, url: downloadPage, fileId };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// --- panel message builder ---
function buildPanelEmbed(guildCfg) {
  const panel = guildCfg.panel || defaultPanel();
  const embed = new EmbedBuilder()
    .setTitle(panel.title || "Support")
    .setDescription(panel.description || "Abra um ticket")
    .setColor(panel.color ?? DEFAULT_COLOR)
    .setFooter({
      text: panel.footerText || "",
      iconURL: panel.footerIcon || null,
    });

  // banner -> setImage; thumbnail -> setThumbnail
  if (panel.bannerURL) embed.setImage(panel.bannerURL);
  if (panel.thumbnailURL) embed.setThumbnail(panel.thumbnailURL);
  return embed;
}

// --- embed editor builder ---
function buildEditorEmbed(embedData) {
  // Utilitário: clampa textos para evitar erros de limite do Discord
  const clampEmbedText = (text, max) => {
    const val = typeof text === "string" ? text : (text == null ? null : String(text));
    if (val == null) return null;
    const trimmed = val.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, max);
  };

  // Garante estrutura segura
  const safeData = embedData && typeof embedData === 'object' ? embedData : {};
  const title = clampEmbedText(safeData.title || "Embed de Exemplo", 256);
  const description = clampEmbedText(safeData.description || "Use os botões para editar o conteúdo.", 4000);
  const footerText = clampEmbedText(safeData.footerText || null, 2048);
  const color = Number.isInteger(safeData.color) ? safeData.color : DEFAULT_COLOR;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color);

  if (footerText) {
    const footerIcon = typeof safeData.footerIcon === 'string' && safeData.footerIcon.trim() ? safeData.footerIcon : null;
    embed.setFooter({ text: footerText, iconURL: footerIcon });
  }

  if (typeof safeData.imageURL === 'string' && safeData.imageURL.trim()) embed.setImage(safeData.imageURL);
  if (typeof safeData.thumbnailURL === 'string' && safeData.thumbnailURL.trim()) embed.setThumbnail(safeData.thumbnailURL);

  // Adiciona campos, se existirem (filtra itens inválidos)
  const fieldsArray = Array.isArray(safeData.fields) ? safeData.fields : [];
  for (const field of fieldsArray) {
    if (!field || typeof field !== 'object') continue;
    const name = clampEmbedText(field.name, 256) || "Campo";
    const value = clampEmbedText(field.value, 1024) || "";
    const inline = !!field.inline;
    embed.addFields({ name, value, inline });
  }

  return embed;
}

// (NOVO) --- product editor builder ---
function buildProductEmbed(productData) {
  const embed = new EmbedBuilder()
    .setTitle(productData.title || "Nome do Produto")
    .setDescription(productData.description || "Descrição do produto.")
    .setColor(productData.color ?? DEFAULT_COLOR)
    .setFooter({
      text: productData.footerText || "",
      iconURL: productData.footerIcon || null,
    });

  if (productData.bannerURL) embed.setImage(productData.bannerURL);
  if (productData.thumbnailURL) embed.setThumbnail(productData.thumbnailURL);

  // Adiciona campos de Preço e Estoque
  embed.addFields(
    {
      name: "Preço",
      value: `R$ ${productData.price.toFixed(2)}`,
      inline: true,
    },
    {
      name: "Estoque",
      value: productData.stock === -1 ? "Ilimitado" : `${productData.stock} unidades`,
      inline: true,
    }
  );

  return embed;
}


// --- (NOVO) Helper para construir a embed PROFISSIONAL de abertura de ticket ---
function buildTicketOpenEmbed(user, panel, reason = "Suporte Geral") {
  const ticketEmbed = new EmbedBuilder()
    .setTitle(`<:icons_Correct:1313526801120755743> Ticket Aberto ${panel.title || "Support"}`)
    .setDescription(
      `Olá <@${user.id}>, seu ticket foi criado com sucesso.
      
Enquanto aguarda, por favor, detalhe seu problema ou dúvida para que nossa equipe possa te ajudar o mais rápido possível.`
    )
    .addFields(
      { name: "👤 Usuário", value: `${user.tag}`, inline: true },
      { name: "📋 Motivo", value: reason, inline: true }
    )
    .setColor(panel.color || DEFAULT_COLOR)
    .setFooter({
      text: panel.footerText || "",
      iconURL: panel.footerIcon || null,
    })
    .setTimestamp(); // Adiciona timestamp

  // thumbnail prefer: bot avatar then configured thumb
  const botAvatar = client.user.displayAvatarURL();
  if (panel.thumbnailURL) ticketEmbed.setThumbnail(panel.thumbnailURL);
  else if (botAvatar) ticketEmbed.setThumbnail(botAvatar);

  return ticketEmbed;
}

// --- (NOVO) Helper para construir os botões do editor do /config-painel ---
function buildPanelEditorComponents(panel, emojis) {
  const components = [];

  // Row 1: Edições Básicas (Sempre visível)
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("edit-title")
      .setLabel("Editar Título")
      .setStyle(ButtonStyle.Primary)
      .setEmoji(emojis.EDIT_EMOJI),
    new ButtonBuilder()
      .setCustomId("edit-desc")
      .setLabel("Editar Descrição")
      .setStyle(ButtonStyle.Primary)
      .setEmoji(emojis.EDIT_EMOJI)
  );

  // Row 2: Toggles (Sempre visível)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("toggle-panel-type")
      .setLabel(`Ticket Simples: ${panel.panelType === "simple" ? "Ligado" : "Desligado"}`)
      .setStyle(panel.panelType === "simple" ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("toggle-advanced-config")
      .setLabel(`Avançado: ${panel.advancedConfig ? "Ligado" : "Desligado"}`)
      .setStyle(panel.advancedConfig ? ButtonStyle.Success : ButtonStyle.Danger)
      .setDisabled(panel.panelType === "simple") // Desativa se o modo simples estiver ativo
  );
  components.push(row1, row2);

  // Se o modo for Padrão (select menu)
  if (panel.panelType === "default") {
    // Row 3: Edições de Mídia
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("edit-color")
        .setLabel("Editar Cor (hex)")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(emojis.EDIT_EMOJI),
      new ButtonBuilder()
        .setCustomId("edit-banner")
        .setLabel("Editar Banner (URL)")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(emojis.EDIT_EMOJI),
      new ButtonBuilder()
        .setCustomId("edit-thumb")
        .setLabel("Editar Miniatura (URL)")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(emojis.EDIT_EMOJI),
      new ButtonBuilder()
        .setCustomId("edit-footer")
        .setLabel("Editar Footer")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(emojis.EDIT_EMOJI)
    );
    components.push(row3);

    // Row 4: Edições Avançadas (Se ativado)
    if (panel.advancedConfig) {
      const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("edit-selects")
          .setLabel("Editar Opções (Select)")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("ready-panel")
          .setLabel("Painel Pronto")
          .setStyle(ButtonStyle.Success)
          .setEmoji("✨")
      );
      components.push(row4);
    }
  }
  // Se o modo for Simples (botão único)
  else {
    // Row 3: Edição do Botão Simples
    const row3Simple = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("edit-simple-label")
        .setLabel("Editar Nome do Botão")
        .setStyle(ButtonStyle.Primary)
        .setEmoji(emojis.EDIT_EMOJI)
    );
    components.push(row3Simple);
  }

  // Row Final: Salvar (Sempre visível)
  const rowSave = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("save-panel")
      .setLabel("Salvar Alterações")
      .setStyle(ButtonStyle.Success)
      .setEmoji(emojis.PIN_EMOJI)
  );
  components.push(rowSave);

  return components;
}

// (NOVO) Helper para botões do editor de !criarproduto
function buildProductEditorComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("edit-prod-title").setLabel("Título").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("edit-prod-desc").setLabel("Descrição").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("edit-prod-color").setLabel("Cor (hex)").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("edit-prod-price").setLabel("Preço (ex: 19.99)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("edit-prod-stock").setLabel("Estoque (ex: 10 ou -1)").setStyle(ButtonStyle.Success)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("edit-prod-banner").setLabel("Banner (URL)").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("edit-prod-thumb").setLabel("Miniatura (URL)").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("edit-prod-footer").setLabel("Footer").setStyle(ButtonStyle.Secondary)
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("send-product").setLabel("Enviar Produto").setStyle(ButtonStyle.Success)
  );
  return [row1, row2, row3, row4];
}

// (NOVO) Helper para botões do editor do /embed
function buildEmbedEditorComponents(EMOJIS) {
  // Botões de Edição (Linha 1)
  const editRow1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("edit-embed-title").setLabel("Título").setStyle(ButtonStyle.Primary).setEmoji(EMOJIS.EDIT_EMOJI),
    new ButtonBuilder().setCustomId("edit-embed-desc").setLabel("Descrição").setStyle(ButtonStyle.Primary).setEmoji(EMOJIS.EDIT_EMOJI),
    new ButtonBuilder().setCustomId("edit-embed-color").setLabel("Cor (hex)").setStyle(ButtonStyle.Secondary).setEmoji(EMOJIS.EDIT_EMOJI),
  );
  // Botões de Edição de Mídia (Linha 2)
  const editRow2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("edit-embed-banner").setLabel("Banner").setStyle(ButtonStyle.Secondary).setEmoji(EMOJIS.EDIT_EMOJI),
    new ButtonBuilder().setCustomId("edit-embed-thumb").setLabel("Miniatura").setStyle(ButtonStyle.Secondary).setEmoji(EMOJIS.EDIT_EMOJI),
    new ButtonBuilder().setCustomId("edit-embed-footer").setLabel("Footer").setStyle(ButtonStyle.Secondary).setEmoji(EMOJIS.EDIT_EMOJI),
  );
  // Botões de Edição de Campos (Linha 3)
  const editRow3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("edit-embed-field1").setLabel("Campo 1").setStyle(ButtonStyle.Success).setEmoji(EMOJIS.EDIT_EMOJI),
    new ButtonBuilder().setCustomId("edit-embed-field2").setLabel("Campo 2").setStyle(ButtonStyle.Success).setEmoji(EMOJIS.EDIT_EMOJI),
    new ButtonBuilder().setCustomId("edit-embed-field3").setLabel("Campo 3").setStyle(ButtonStyle.Success).setEmoji(EMOJIS.EDIT_EMOJI),
    new ButtonBuilder().setCustomId("edit-embed-clear-fields").setLabel("Limpar Campos").setStyle(ButtonStyle.Danger),
  );
  // Botões de Ação (Linha 4)
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("post-embed").setLabel("Postar Embed").setStyle(ButtonStyle.Success).setEmoji(EMOJIS.POST_EMOJI),
    new ButtonBuilder().setCustomId("post-embed-webhook").setLabel("Postar Webhook").setStyle(ButtonStyle.Secondary).setEmoji(EMOJIS.WEBHOOK_EMOJI),
    new ButtonBuilder().setCustomId("export-embed").setLabel("Exportar JSON").setStyle(ButtonStyle.Primary).setEmoji(EMOJIS.EXPORT_EMOJI),
    new ButtonBuilder().setCustomId("import-embed").setLabel("Importar JSON").setStyle(ButtonStyle.Primary).setEmoji(EMOJIS.IMPORT_EMOJI),
  );
  return [editRow1, editRow2, editRow3, actionRow];
}

// (NOVO) Helper para botões do !configpay
function buildPaymentPanelComponents(paymentConfig) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("toggle-payment")
      .setLabel(`Pagamentos: ${paymentConfig.enabled ? "Ativados" : "Desativados"}`)
      .setStyle(paymentConfig.enabled ? ButtonStyle.Success : ButtonStyle.Danger)
  );

  const components = [row1];

  if (paymentConfig.enabled) {
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("config-mp")
        .setLabel("Configurar Mercado Pago")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("💳"),
      new ButtonBuilder()
        .setCustomId("config-pix")
        .setLabel("Configurar Pix Manual")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🔑")
    );
    const modeText = paymentConfig.pixMode === 'qrcode_static' ? 'QR CODE Estático' : 'Texto';
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("noop-pix-mode-display")
        .setLabel(`Modo Pix Manual: ${modeText}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
    components.push(row2, row3);
  }

  return components;
}

// (NOVO) Mockups de Geração de Pagamento
function generateMercadoPagoPayment(product, token) {
  // --- INÍCIO DO MOCKUP ---
  // Em uma implementação real, você usaria o SDK do Mercado Pago
  // ex: const payment = await mercadopago.payment.create(...)
  // Isso retornaria o payment.point_of_interaction.transaction_data
  // --- FIM DO MOCKUP ---

  const mockQRCodeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAPoAAAD6CAIAAAAHjs1qAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAEVSURBVHja7cExAQAAAMKg9U/tbwagAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgHw23QABgADemgAAAABJRU5ErkJggg=="; // Imagem de QR Code placeholder
  const mockPixCopiaECola = "00020126... (este é um pix copia e cola de exemplo) ...5303986540519.995802BR59... (fim do exemplo)";

  const embed = new EmbedBuilder()
    .setTitle(`Pagamento via Mercado Pago: ${product.title}`)
    .setDescription("Escaneie o QR Code abaixo ou use o Pix Copia e Cola para pagar.")
    .addFields(
      { name: "Valor", value: `R$ ${product.price.toFixed(2)}` },
      { name: "Pix Copia e Cola", value: `\`\`\`${mockPixCopiaECola}\`\`\`` }
    )
    .setImage(`data:image/png;base64,${mockQRCodeBase64}`) // Mock de QR code
    .setColor(0x00A6FF) // Cor do Mercado Pago
    .setFooter({ text: "Este é um pagamento simulado (mock)." });

  return embed;
}

// Função para gerar pagamento Pix Manual (sem QR code, apenas chave)
function generatePixPayment(product, pixType, pixKey) {
  const embed = new EmbedBuilder()
    .setTitle(`💳 Pagamento via Pix Manual`)
    .setDescription(`**Produto:** ${product.title}\n\nUtilize a chave PIX abaixo para realizar o pagamento via seu aplicativo bancário.`)
    .addFields(
      { name: "💰 Valor", value: `R$ ${product.price.toFixed(2)}`, inline: true },
      { name: "🔑 Tipo de Chave", value: pixType.toUpperCase(), inline: true },
      { name: "📋 Chave PIX", value: `\`\`\`${pixKey}\`\`\``, inline: false }
    )
    .setColor(DEFAULT_COLOR)
    .setThumbnail(product.thumbnailURL || null)
    .setFooter({ text: "⚠️ Após realizar o pagamento, envie o comprovante neste canal." })
    .setTimestamp();

  return embed;
}


// --- register slash commands on ready ---
client.once(Events.ClientReady, async () => {
  console.log(`<:icons_Correct:1313526801120755743> Bot online como ${client.user.tag}`);

  // ATUALIZADO: Define o status de transmissão com link Twitch
  try {
    client.user.setActivity("/help", {
      type: ActivityType.Streaming,
      url: "https://www.google.com", // URL genérica
    });
  } catch (err) {
    console.error("Erro ao definir status:", err);
  }

  // load current configs
  guildConfigs = loadConfigs();

  // Garante o cargo fixo do bot em todos os servidores conectados
  try {
    for (const g of client.guilds.cache.values()) {
      await ensureBotRole(g);
    }
  } catch (e) {
    console.warn("[YolooRole] Falha ao garantir cargos em todas as guilds:", e?.message || e);
  }

  // Detecta alterações de código e envia log de inicialização
  try {
    const currentSig = computeCodeSignature();
    for (const [gid, cfg] of Object.entries(guildConfigs)) {
      if (!cfg) continue;
      const previousSig = cfg.lastCodeSignature;
      const previousStart = cfg.lastStartTime;
      const isRestart = !!previousStart;
      const hasCodeChange = previousSig && currentSig && previousSig !== currentSig;
      const changeDesc = hasCodeChange ? "Houve atualização de código desde a última execução." : (isRestart ? "Reinício rápido (sem alterações de código)." : "Primeira execução registrada.");
      // Atualiza os marcadores
      cfg.lastCodeSignature = currentSig;
      cfg.lastStartTime = Date.now();
    }
    saveConfigs(guildConfigs);

    await sendStatusLogToConfiguredGuilds({
      title: "🟩 Bot Online",
      description: "O bot foi iniciado e está operacional.",
      color: 0x3fb950,
      fields: [
        { name: "Versão D.js", value: (client.options.version || "14.x"), inline: true },
        { name: "Iniciado às", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      ],
    });
  } catch (e) {
    console.error("Falha ao enviar log de inicialização:", e);
  }

  // Configura notificadores de desligamento
  setupShutdownNotifiers();

  // register commands
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName("config-painel")
      .setDescription("Cria/edita o painel de tickets (embed editável)"),

    // COMANDO /say
    new SlashCommandBuilder()
      .setName("say")
      .setDescription("Faz o bot falar uma mensagem em um canal")
      .addStringOption((option) =>
        option
          .setName("mensagem")
          .setDescription("O que o bot deve dizer")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages), // Requer permissão de Gerenciar Mensagens
    // COMANDO /status
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Retorna o status atual do bot (ping)"),
    // COMANDO /boas-vindas
    new SlashCommandBuilder()
      .setName("boas-vindas")
      .setDescription("Configura o canal para a mensagem de boas-vindas")
      .addChannelOption((opt) =>
        opt
          .setName("canal")
          .setDescription("Canal onde o bot enviará as boas-vindas")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText) // Garante que seja um canal de texto
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild), // Permissão: Gerenciar Servidor
    // COMANDO /saida-config
    new SlashCommandBuilder()
      .setName("saida-config")
      .setDescription("Configura o canal para a mensagem de saída")
      .addChannelOption((opt) =>
        opt
          .setName("canal")
          .setDescription("Canal onde o bot enviará a mensagem de saída")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText) // Garante que seja um canal de texto
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild), // Permissão: Gerenciar Servidor
    // COMANDO /help
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Mostra a lista e descrição de todos os comandos do bot"),

    // NOVO COMANDO /auto-role
    new SlashCommandBuilder()
      .setName("auto-role")
      .setDescription("Configura os cargos que novos membros receberão automaticamente.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles), // Permissão: Gerenciar Cargos
    // NOVO COMANDO /embed
    new SlashCommandBuilder()
      .setName("embed")
      .setDescription("Abre o editor profissional de embeds para criar e postar mensagens.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages), // Permissão: Gerenciar Mensagens

    // NOVO COMANDO: /planos
    new SlashCommandBuilder()
      .setName("planos")
      .setDescription("Exibe os planos da Yoloo com benefícios."),

    // --- (NOVOS COMANDOS SOLICITADOS) ---
    new SlashCommandBuilder()
      .setName("support")
      .setDescription("Solicita suporte para um agente Yoloo."),

    new SlashCommandBuilder()
      .setName("criar-servidores")
      .setDescription("Cria servidores Discord personalizados."),


    new SlashCommandBuilder()
      .setName("daily-currency")
      .setDescription("Resgata sua moeda diária YC (24h)")
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName("perfil")
      .setDescription("Mostra sua info YC em imagem")
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName("ranking")
      .setDescription("Ranking de usuários por Yoloo Coins (YC)")
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName("aicloud")
      .setDescription("Cria um canal privado para conversar com a IA Gemini")
      .setDMPermission(false),

  ].map((c) => c.toJSON());

  try {
    // Registra comandos globalmente (evita duplicados com guild commands)
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log("Comandos slash registrados (global).");
    // Limpa comandos por guild para evitar duplicação residual de versões anteriores
    try {
      for (const g of client.guilds.cache.values()) {
        await rest.put(Routes.applicationGuildCommands(client.user.id, g.id), { body: [] });
      }
      console.log("Comandos por guild limpos (evita duplicação antiga).");
    } catch (cleanErr) {
      console.warn("Falha ao limpar comandos por guild:", cleanErr?.message || cleanErr);
    }


  } catch (err) {
    console.error("Falha ao registrar comandos:", err);
  }
});

// --- interaction handling ---
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Shared Emojis for Panels
    const EMOJIS = {
      EDIT_EMOJI: { id: EMOJI_MAP.pincel },
      PIN_EMOJI: { id: EMOJI_MAP.save },
      EXPORT_EMOJI: "📤",
      IMPORT_EMOJI: "📥",
      POST_EMOJI: "🚀",
      WEBHOOK_EMOJI: "🔗",
      GREEN_MARK_EMOJI: { id: EMOJI_MAP.correct },
    };

    // Slash: /say
    if (interaction.isChatInputCommand() && interaction.commandName === "say") {
      trackCommandUsage('say');
      if (!interaction.guild) { await interaction.reply({ content: "Este comando só pode ser usado em servidores.", ephemeral: true }); return; }
      // Verifica se o usuário tem a permissão configurada no comando (Gerenciar Mensagens)
      if (!interaction.member || !interaction.member.permissions?.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({
          content: "Você precisa de permissão de `Gerenciar Mensagens` para usar este comando.",
          ephemeral: true,
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0xffaa00)
        .setTitle("Comando indisponível no Discord")
        .setDescription("Use nosso site oficial para enviar mensagens com recursos avançados.");
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL("https://yoloosystem.vercel.app").setLabel("Abrir Yoloo Cloud")
      );
      await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      return;
    }


    // Slash: /status (mantido igual)
    if (interaction.isChatInputCommand() && interaction.commandName === "status") {
      trackCommandUsage('status');
      await interaction.deferReply(); // DeferReply para ter tempo de calcular o ping

      const ping = client.ws.ping;
      const uptime = Math.floor(client.uptime / 1000); // Tempo de atividade em segundos
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = uptime % 60;

      // Detecta onde o bot está hospedado
      let hosting = "Desconhecida (Node.js)";
      if (process.env.NODE_ENV === "production") {
        hosting = "Hospedado com (VertraCloud)";
      } else if (process.env.CODESPACES === "true" || process.env.GITHUB_CODESPACES === "true") {
        hosting = "GitHub Codespaces";
      } else if (process.env.RAILWAY_ENVIRONMENT) {
        hosting = "Railway";
      } else if (process.env.KUBE_POD_NAME) {
        hosting = "Kubernetes";
      }

      const statusEmbed = new EmbedBuilder()
        .setColor(DEFAULT_COLOR)
        .setTitle("📊 Status do Bot")
        .setThumbnail(client.user.displayAvatarURL() || THUMBNAIL_FALLBACK)
        .addFields(
          { name: "📡 Latência (Ping)", value: `${ping}ms`, inline: true },
          { name: "⏱️ Tempo de Atividade", value: `${days}d ${hours}h ${minutes}m ${seconds}s`, inline: true },
          { name: "🏠 Hospedagem", value: hosting, inline: false },
          { name: "🌐 Guilds/Servidores", value: `${client.guilds.cache.size}`, inline: true },
          { name: "👥 Usuários Atendidos", value: `${client.users.cache.size}`, inline: true },
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [statusEmbed] });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "daily-currency") {
      trackCommandUsage('daily-currency');
      if (!interaction.guild) { await interaction.reply({ content: "Use em um servidor.", ephemeral: true }); return; }
      const db = loadUsersDb();
      const rec = getUserRecord(db, interaction.user.id);
      const waitMs = millisUntilNextClaim(rec.lastClaimAt);
      if (waitMs > 0) {
        const remaining = formatDurationPt(waitMs);
        const emojiTag = resolveEmojiTagById(DAILY_EMOJI_ID, ":yoloocoinprata:", "yoloocoinprata");
        logFailure('daily-currency', interaction.user.id, interaction.guildId, 'cooldown_active', { remaining });
        await interaction.reply({ content: `${emojiTag} Você já resgatou sua moeda diária. Tente novamente em ${remaining}.`, ephemeral: true });
        return;
      }
      rec.balance = (rec.balance || 0) + YC_AMOUNT;
      rec.lastClaimAt = new Date().toISOString();
      rec.claims.push({ type: "daily", amount: YC_AMOUNT, serverId: interaction.guildId, claimedAt: rec.lastClaimAt });
      saveUsersDb(db);
      const emojiTag = resolveEmojiTagById(DAILY_EMOJI_ID, ":yoloocoinprata:", "yoloocoinprata");
      await interaction.reply({ content: `${emojiTag} Você recebeu 1500 YC (Yoloo Coins). Retorne em 24 horas para resgatar novamente.`, ephemeral: true });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "perfil") {
      trackCommandUsage('perfil');
      const db = loadUsersDb();
      const rec = getUserRecord(db, interaction.user.id);
      try {
        const buf = await buildInfoImage(interaction.user, rec.balance || 0);
        const att = new AttachmentBuilder(buf, { name: "yoloo-info.png" });
        await interaction.reply({ files: [att], ephemeral: true });
      } catch (e) {
        const emojiTag = resolveEmojiTagById(DAILY_EMOJI_ID, ":yoloocoinprata:", "yoloocoinprata");
        const embed = new EmbedBuilder()
          .setColor(DEFAULT_COLOR)
          .setTitle("Perfil CDS Network")
          .setDescription(`${emojiTag} Saldo: **${rec.balance || 0} YC**`)
          .setThumbnail(interaction.user.displayAvatarURL())
          .setFooter({ text: "Renderização de imagem indisponível no ambiente", iconURL: client.user.displayAvatarURL() })
          .setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true });
      }
      return;
    }

    // Slash: /boas-vindas (mantido igual)
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "boas-vindas"
    ) {
      if (!interaction.guild || !interaction.member || !interaction.member.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: "Você precisa de `Gerenciar Servidor` para usar isto.",
          ephemeral: true,
        });
        return;
      }
      const channel = interaction.options.getChannel("canal");
      if (!channel || channel.type !== ChannelType.GuildText) {
        await interaction.reply({
          content: "Por favor selecione um **canal de texto** válido.",
          ephemeral: true,
        });
        return;
      }
      const guildCfg = ensureGuildConfig(interaction.guildId);
      guildCfg.welcomeChannelId = channel.id;
      saveConfigs(guildConfigs);
      appendJsonArray(WELCOME_LOG_FILE, { userId: interaction.user.id, guildId: interaction.guildId, channelId: channel.id, timestamp: new Date().toISOString() });
      await interaction.reply({
        content: `<:icons_Correct:1313526801120755743> Canal de Boas-Vindas definido: **${channel.name}**`,
        ephemeral: true,
      });
      return;
    }

    // Slash: /saida-config (mantido igual)
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "saida-config"
    ) {
      if (!interaction.guild || !interaction.member || !interaction.member.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: "Você precisa de `Gerenciar Servidor` para usar isto.",
          ephemeral: true,
        });
        return;
      }
      const channel = interaction.options.getChannel("canal");
      if (!channel || channel.type !== ChannelType.GuildText) {
        await interaction.reply({
          content: "Por favor selecione um **canal de texto** válido.",
          ephemeral: true,
        });
        return;
      }
      const guildCfg = ensureGuildConfig(interaction.guildId);
      guildCfg.leaveChannelId = channel.id;
      saveConfigs(guildConfigs);
      appendJsonArray(LEAVE_LOG_FILE, { userId: interaction.user.id, guildId: interaction.guildId, channelId: channel.id, timestamp: new Date().toISOString() });
      await interaction.reply({
        content: `<:icons_Correct:1313526801120755743> Canal de Saída definido: **${channel.name}**`,
        ephemeral: true,
      });
      return;
    }

    // Slash: /help (ATUALIZADO)
    if (interaction.isChatInputCommand() && interaction.commandName === "help") {
      trackCommandUsage('help');
      const helpEmbed = new EmbedBuilder()
        .setColor(DEFAULT_COLOR)
        .setTitle("📖 Guia de Comandos do Bot")
        .setDescription(
          "Aqui estão todos os comandos disponíveis para interação e administração do bot."
        )
        .setThumbnail(client.user.displayAvatarURL() || THUMBNAIL_FALLBACK)
        .addFields(
          // Comandos de Utilidade
          { name: "🔨 Utilidade", value: "Comandos gerais para todos os usuários.", inline: false },
          { name: "`/help`", value: "Mostra esta lista de comandos.", inline: true },
          { name: "`/status`", value: "Mostra a latência e tempo de atividade do bot.", inline: true },
          { name: "`/support`", value: "Solicita suporte (via DM) para compras.", inline: true },
          { name: "`/daily-currency`", value: "Resgata sua moeda diária (YC) com segurança.", inline: true },
          { name: "`/perfil`", value: "Mostra sua info CDS em imagem profissional.", inline: true },

          // Comandos de Administração
          { name: "\u200b", value: "\u200b", inline: false }, // Separador
          { name: "⚙️ Administração (Permissões)", value: "Comandos que exigem permissões elevadas.", inline: false },
          { name: "`/say <mensagem>`", value: "Faz o bot enviar a mensagem no canal atual. (Requer Gerenciar Mensagens)", inline: true },
          { name: "`/boas-vindas <canal>`", value: "Define o canal onde novos usuários receberão a mensagem de boas-vindas. (Requer Gerenciar Servidor)", inline: true },
          { name: "`/saida-config <canal>`", value: "Define o canal onde saídas de usuários serão notificadas. (Requer Gerenciar Servidor)", inline: true },
          { name: "`/auto-role`", value: "Define os cargos automáticos para novos membros. (Requer Gerenciar Cargos)", inline: true },
          { name: "`/embed`", value: "Abre o editor profissional para criar embeds. (Requer Gerenciar Mensagens)", inline: true },


          { name: "\u200b", value: "\u200b", inline: false }, // Separador
          // Comandos de Ticket e Configuração
          { name: "🎫 Tickets e Config", value: "Comandos para gerenciar o sistema de tickets.", inline: false },
          { name: "`/config-users`", value: "Seleciona os cargos de suporte para tickets.", inline: true },
          { name: "`/config-channel <categoria>`", value: "Define a categoria para criar os tickets.", inline: true },
          { name: "`/config-painel`", value: "Cria e edita o painel de tickets com temas prontos (GTA RP, Comunidade, Amigos, Dev). As alterações são salvas apenas ao clicar em 'Salvar Alterações'.", inline: true },

          { name: "\u200b", value: "\u200b", inline: false }, // Separador
          { name: "🛍️ Sistema de Vendas", value: "O sistema de vendas está em revisão e desenvolvimento para corrigir integrações com bancos e Pix. Em breve estará de volta, mais robusto e seguro.", inline: false }
        )
        .setFooter({
          text: `Use os comandos com a barra (/) ou exclamação (!) no Discord.`,
          iconURL: client.user.displayAvatarURL(),
        })
        .setTimestamp();

      await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
      return;
    }

    // Slash: /devsummary (mantido igual)
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "devsummary"
    ) {
      await interaction.deferReply({ ephemeral: true });

      const startTimeInSeconds = Math.floor(START_TIME.getTime() / 1000);

      const summaryEmbed = new EmbedBuilder()
        .setColor(DEFAULT_COLOR)
        .setTitle("🛠️ Resumo de Desenvolvimento e Operação")
        .setDescription("Informações importantes sobre a última inicialização e status de código.")
        .addFields(
          {
            name: "⏳ Última Inicialização (Desligamento)",
            value: `O bot foi reiniciado pela última vez em: <t:${startTimeInSeconds}:F> (<t:${startTimeInSeconds}:R>). \nIsso reflete o último 'commit' de código ou reinício da máquina.`,
            inline: false
          },
          {
            name: "⚙️ Resumo do Último Código",
            value: "Novas funcionalidades implementadas: Comandos `/say`, `/status`, `/help`, `/devsummary`, `/boas-vindas`, `/saida-config`, `/auto-role`, `/embed`, `/dmservice`, `/yoloosupport`, `!configpay`, `!criarproduto` e sistema de carrinho/pagamento (mock).",
            inline: false
          },
          {
            name: "<:icons_Correct:1313526801120755743> Status Operacional",
            value: "Todos os sistemas e APIs estão operando normalmente.",
            inline: true
          },
          {
            name: "🌐 Versão Discord.js",
            // Usa require dinâmico para compatibilidade com import, embora não seja o ideal, se o seu ambiente suportar require para discord.js.
            // Para maior robustez em módulos ES, você precisaria importar de outra forma, mas manteremos o existente com tratamento básico.
            value: "v" + (client.options.version || "14.x (provável)"), // Versão real é difícil de obter assim, mantendo a forma anterior com fallback.
            inline: true
          },
        )
        .setFooter({ text: "Dados de tempo de inicialização.", iconURL: client.user.displayAvatarURL() })
        .setTimestamp();

      await interaction.editReply({ embeds: [summaryEmbed] });
      return;
    }




    // role select handler (mantido igual)
    if (
      interaction.isRoleSelectMenu() &&
      interaction.customId === "select-support-roles"
    ) {
      if (!interaction.guild || !interaction.member || !interaction.member.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: "Você precisa de permissão para gerenciar o servidor.",
          ephemeral: true,
        });
        return;
      }
      const guildCfg = ensureGuildConfig(interaction.guildId);
      guildCfg.supportRoles = interaction.roles.map((r) => r.id);
      saveConfigs(guildConfigs);
      appendJsonArray(CONFIG_USERS_LOG_FILE, { userId: interaction.user.id, guildId: interaction.guildId, roles: interaction.roles.map(r => r.id), timestamp: new Date().toISOString() });
      await interaction.reply({
        content: `<:icons_Correct:1313526801120755743> Cargos de suporte atualizados: ${interaction.roles.map((r) => r.name).join(", ") || "nenhum"
          }`,
        ephemeral: true,
      });
      return;
    }

    // Slash: /auto-role (NOVO COMANDO)
    if (interaction.isChatInputCommand() && interaction.commandName === "auto-role") {
      trackCommandUsage('auto-role');
      if (!interaction.guild || !interaction.member || !interaction.member.permissions?.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.reply({
          content: "Você precisa de `Gerenciar Cargos` para usar isto.",
          ephemeral: true,
        });
        return;
      }
      ensureGuildConfig(interaction.guildId);

      const row = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId("select-auto-roles")
          .setPlaceholder("Selecione de 1 a 5 cargos para novos membros")
          .setMinValues(1)
          .setMaxValues(5)
      );

      const currentRoles = (ensureGuildConfig(interaction.guildId).autoRoles || [])
        .map(roleId => interaction.guild.roles.cache.get(roleId)?.name || `ID: ${roleId}`)
        .join(", ") || "Nenhum cargo automático configurado.";

      const embed = new EmbedBuilder()
        .setTitle("Configuração de Cargos Automáticos")
        .setDescription("Selecione abaixo os cargos que serão automaticamente atribuídos a novos membros ao entrar no servidor.")
        .addFields({ name: "Cargos Atuais", value: currentRoles, inline: false })
        .setColor(DEFAULT_COLOR)
        .setThumbnail(client.user.displayAvatarURL() || THUMBNAIL_FALLBACK);

      await interaction.reply({
        embeds: [embed],
        components: [row],
        ephemeral: true,
      });
      return;
    }

    // Role select handler for /auto-role (NOVO HANDLER)
    if (
      interaction.isRoleSelectMenu() &&
      interaction.customId === "select-auto-roles"
    ) {
      if (!interaction.guild || !interaction.member || !interaction.member.permissions?.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.reply({
          content: "Você precisa de permissão para gerenciar cargos.",
          ephemeral: true,
        });
        return;
      }

      const guildCfg = ensureGuildConfig(interaction.guildId);
      const selectedRoleIds = interaction.roles.map((r) => r.id);

      // Verifica se o bot pode atribuir esses cargos (permissão e hierarquia)
      const botMember = interaction.guild.members.cache.get(client.user.id);
      const canAssign = interaction.roles.every(role =>
        role.editable && // O bot pode editar o cargo (não é cargo de integração)
        (botMember.roles.highest.position > role.position) // O bot está acima do cargo na hierarquia
      );

      if (!canAssign) {
        await interaction.reply({
          content: "⚠️ Aviso: Um ou mais cargos selecionados estão acima do meu cargo na hierarquia do servidor ou não são editáveis. Não poderei atribuí-los.",
          ephemeral: true,
        });
        // Não retorna, permite salvar a configuração com aviso
      }

      guildCfg.autoRoles = selectedRoleIds;
      saveConfigs(guildConfigs);
      appendJsonArray(AUTO_ROLE_LOG_FILE, { userId: interaction.user.id, guildId: interaction.guildId, roles: selectedRoleIds, timestamp: new Date().toISOString() });

      await interaction.update({
        content: `<:icons_Correct:1313526801120755743> Cargos automáticos atualizados: ${interaction.roles.map((r) => r.name).join(", ") || "nenhum"
          }`,
        embeds: [],
        components: [], // Remove o menu de seleção após a atualização
        ephemeral: true,
      });
      return;
    }




    // /config-painel (ATUALIZADO com novo helper de botões)
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "config-painel"
    ) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: "Você precisa de `Gerenciar Servidor` para usar isto.",
          ephemeral: true,
        });
        return;
      }
      const guildCfg = ensureGuildConfig(interaction.guildId);

      // Constrói os botões usando o helper
      const components = buildPanelEditorComponents(guildCfg.panel, EMOJIS);

      const embed = buildPanelEmbed(guildCfg);
      const extraRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("configpanel-config-channel").setLabel("Configurar Categoria").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("configpanel-config-users").setLabel("Configurar Cargos de Suporte").setStyle(ButtonStyle.Secondary)
      );
      await interaction.reply({
        embeds: [embed],
        components: [...components, extraRow],
        ephemeral: true,
      });
      return;
    }

    // Slash: /embed (NOVO COMANDO)
    if (interaction.isChatInputCommand() && interaction.commandName === "embed") {
      trackCommandUsage('embed');
      if (!interaction.guild || !interaction.member || !interaction.member.permissions?.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({
          content: "Você precisa de `Gerenciar Mensagens` para usar isto.",
          ephemeral: true,
        });
        return;
      }
      const guildCfg = ensureGuildConfig(interaction.guildId);
      // Reseta o editor de embed temporário para o padrão ou carrega o último estado
      if (!guildCfg.tempEmbed) {
        guildCfg.tempEmbed = defaultEmbed();
      }

      const [editRow1, editRow2, editRow3, actionRow] = buildEmbedEditorComponents(EMOJIS);

      const embed = buildEditorEmbed(guildCfg.tempEmbed);

      // Editor de embed visível somente para o usuário (efêmero)
      await interaction.reply({
        content: "**🎨 Editor de Embed Profissional**\nUse os botões para editar o preview abaixo. O embed será salvo no estado temporário do servidor até que você o poste ou importe outro.",
        embeds: [embed],
        components: [editRow1, editRow2, editRow3, actionRow],
        ephemeral: true,
      });
      // O preview persistente continuará sendo rastreado via guildCfg.tempEmbedMessageId quando postado
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "ranking") {
      trackCommandUsage('ranking');
      await interaction.deferReply({ ephemeral: true });
      const db = loadUsersDb();
      const arr = Object.values(db || {}).map(v => ({ userId: v.userId, balance: Number(v.balance || 0) }));
      arr.sort((a, b) => b.balance - a.balance);
      const top = arr.slice(0, 20);
      const resolved = [];
      for (const e of top) {
        let name = null;
        try { const u = await client.users.fetch(e.userId, { force: false }); name = u?.username || null; } catch { }
        resolved.push({ userId: e.userId, username: name || e.userId, balance: e.balance });
      }
      saveRanking(arr);
      const desc = resolved.length ? resolved.map((e, i) => `${i + 1}. ${e.username} • ${e.userId} • ${e.balance} YC`).join("\n") : "Sem dados.";
      const embed = new EmbedBuilder()
        .setTitle("🏆 Ranking CDS Coins")
        .setDescription(desc.slice(0, 3900))
        .setColor(DEFAULT_COLOR)
        .setFooter({ text: "CDS Network", iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }


    // --- (NOVOS COMANDOS SLASH) ---
    // Slash: /planos-yoloo (NOVO)
    if (interaction.isChatInputCommand() && interaction.commandName === "planos") {
      trackCommandUsage('planos');
      const embed = new EmbedBuilder()
        .setColor(0x2f81f7)
        .setTitle("🌩️ Yoloo Cloud |Planos e Benefícios")
        .setDescription("Escolha o plano ideal para o seu servidor e desbloqueie recursos avançados do nosso ecossistema.")
        .addFields(
          {
            name: "Plano Free",
            value: "• Comandos atuais disponíveis\n• Painéis de tickets personalizáveis\n• Editor de embeds\n• Auto-roles e mensagens de boas-vindas/saída\n• Suporte básico via `/yoloosupport`",
            inline: false,
          },
          {
            name: "Plano Esmeralda (Em Breve)",
            value: "Inclui tudo do Free, mais:\n• Novos comandos avançados (prioridade de recursos)\n• Ferramentas de automação e relatórios\n• Integrações adicionais (pagamentos, templates profissionais)\n• Suporte prioritário",
            inline: false,
          },
          {
            name: "Plano Diamond (Em Breve)",
            value: "Inclui tudo do Free e Esmeralda, mais:\n• Acesso antecipado a novas funcionalidades (servidor de testes dedicado)\n• Recursos premium exclusivos\n• Consultoria e onboarding assistido\n• Benefícios adicionais contínuos",
            inline: false,
          }
        )
        .setFooter({ text: "Yoloo Cloud • Planos sujeitos a mudanças" })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }
    // Slash: /config-linguagem (NOVO)
    if (interaction.isChatInputCommand() && interaction.commandName === "config-linguagem") {
      trackCommandUsage('config-linguagem');
      if (!interaction.guild) {
        await interaction.reply({ content: "Use este comando em um servidor.", ephemeral: true });
        return;
      }
      const guildCfg = ensureGuildConfig(interaction.guildId);
      const current = (guildCfg.language || 'br').toUpperCase();

      const embed = new EmbedBuilder()
        .setTitle("🌍 Configuração de Linguagem")
        .setDescription("Selecione abaixo o país/idioma que o bot deverá utilizar neste servidor e clique em 'Salvar'.")
        .addFields({ name: "Atual", value: current, inline: true })
        .setColor(DEFAULT_COLOR)
        .setTimestamp();

      const select = new StringSelectMenuBuilder()
        .setCustomId('select-language')
        .setPlaceholder('Selecione o país/idioma')
        .addOptions(
          { label: 'Brasil (Português)', value: 'br', emoji: '🇧🇷' },
          { label: 'Estados Unidos (Inglês)', value: 'us', emoji: '🇺🇸' },
          { label: 'Espanha (Espanhol)', value: 'es', emoji: '🇪🇸' },
          { label: 'Índia (Inglês/Hindi)', value: 'in', emoji: '🇮🇳' },
          { label: 'China (Chinês)', value: 'cn', emoji: '🇨🇳' },
        );
      const row1 = new ActionRowBuilder().addComponents(select);
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('save-language').setLabel('Salvar').setStyle(ButtonStyle.Success)
      );

      await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
      return;
    }

    // Slash: /yoloosupport (ATUALIZADO com Modal)
    if (interaction.isChatInputCommand() && interaction.commandName === "support") {
      trackCommandUsage('support');
      const modal = new ModalBuilder()
        .setCustomId("modal-support")
        .setTitle("Solicitação de Suporte Yoloo");

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("support-nome")
            .setLabel("Seu Nome")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("Digite seu nome completo")
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("support-email")
            .setLabel("Email De Contato")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("seuemail@exemplo.com")
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("support-motivo")
            .setLabel("Motivo do Suporte")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder("Descreva seu problema ou dúvida...")
        )
      );

      await interaction.showModal(modal);
      return;
    }

    // Slash: /criar-servidores (Aviso de desenvolvimento)
    if (interaction.isChatInputCommand() && interaction.commandName === "criar-servidores") {
      trackCommandUsage('criar-servidores');
      const embed = new EmbedBuilder()
        .setTitle("🧩 Criador de Servidores Em Desenvolvimento")
        .setDescription("Estamos aprimorando a experiência de criação automática de servidores (temas, loja, categorias, cargos e painel de ticket).\n\nLogo menos estará funcional para todos os usuários com uma interface profissional e responsiva.")
        .addFields(
          { name: "O que virá", value: "• Seleção de tema do servidor\n• Seleção do tema da loja\n• Criação automática de categorias/canais/cargos\n• Painel de tickets Yoloo integrado", inline: false },
          { name: "Estado", value: "Em fase de testes internos", inline: true }
        )
        .setColor(0xffaa00)
        .setFooter({ text: "CDS Network", iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // Slash: /yolooAIcloud (NOVO - Gemini AI Integration)
    if (interaction.isChatInputCommand() && interaction.commandName === "aicloud") {
      trackCommandUsage('aicloud');
      await interaction.deferReply({ ephemeral: true });

      try {
        // Obtém o canal atual e sua categoria
        const currentChannel = interaction.channel;
        const parentCategory = currentChannel.parent;

        if (!parentCategory || parentCategory.type !== ChannelType.GuildCategory) {
          await interaction.editReply({
            content: "<:gif_Nao:741653287446773813> Este comando deve ser usado em um canal que possui uma categoria.",
            ephemeral: true
          });
          return;
        }

        // Cria o nome do canal
        const channelName = `🤖-ai-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10)}`;

        // Cria o canal privado
        const newChannel = await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: parentCategory.id,
          permissionOverwrites: [
            { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
          ],
          reason: `Canal de IA criado por ${interaction.user.tag}`
        });

        // Adiciona o canal à lista de canais de IA
        aiChannels.add(newChannel.id);

        // Envia mensagem de boas-vindas no novo canal
        const welcomeEmbed = new EmbedBuilder()
          .setTitle("🤖 Canal de IA Gemini")
          .setDescription(`Olá ${interaction.user}! Este é seu canal privado de IA.\n\nVocê pode conversar livremente fazendo perguntas, pedindo ajuda ou tirando dúvidas. A IA responderá às suas mensagens aqui.`)
          .addFields(
            { name: "💡 Dicas", value: "• Seja específico nas perguntas\n• Pode perguntar sobre programação, tecnologia, gerais\n• Use este canal para soluções de problemas", inline: false }
          )
          .setColor(0x4285F4)
          .setFooter({ text: "Powered by Google Gemini AI", iconURL: client.user.displayAvatarURL() })
          .setTimestamp();

        await newChannel.send({
          content: `Bem-vindo ao seu canal de IA, ${interaction.user}!`,
          embeds: [welcomeEmbed]
        });

        await interaction.editReply({
          content: `<:icons_Correct:1313526801120755743> Canal de IA criado: ${newChannel}`,
          ephemeral: true
        });

      } catch (err) {
        console.error("Erro ao criar canal de IA:", err);
        logFailure('yolooaicloud', interaction.user.id, interaction.guildId, 'create_channel_failed', { error: err?.message });
        await interaction.editReply({
          content: `<:gif_Nao:741653287446773813> Erro ao criar canal de IA: ${err.message}`,
          ephemeral: true
        });
      }

      return;
    }

    // --- (FIM NOVOS COMANDOS SLASH) ---


    // Panel button interactions (open modals for editing) (EDITADO: Adicionado /embed e edit-prod handlers)
    if (interaction.isButton()) {
      // --- Painel Admin: apenas para o dono autorizado ---
      if (interaction.user.id !== process.env.OWNER_ID) {
        await interaction.reply({ content: "Interação negada.", ephemeral: true });
        return;
      }

      if (interaction.customId === "admin-export-servers") {
        try {
          const data = Array.from(client.guilds.cache.values()).map(g => ({ id: g.id, name: g.name }));
          const json = JSON.stringify(data, null, 2);
          await interaction.reply({ content: "Export realizado (json abaixo):", files: [{ attachment: Buffer.from(json, 'utf8'), name: 'servers.json' }], ephemeral: true });
          console.log('[Admin Interaction] export-servers');
        } catch (e) {
          await interaction.reply({ content: "Falha ao exportar.", ephemeral: true });
        }
        return;
      }

      if (interaction.customId === "admin-top-command") {
        const entries = Array.from(commandUsage.entries());
        entries.sort((a, b) => b[1] - a[1]);
        const top = entries[0] ? `/${entries[0][0]} (${entries[0][1]} usos)` : "Nenhum comando registrado ainda.";
        await interaction.reply({ content: `Mais usado: ${top}`, ephemeral: true });
        console.log('[Admin Interaction] top-command');
        return;
      }

      if (interaction.customId === "admin-list-owners") {
        try {
          const owners = [];
          for (const g of client.guilds.cache.values()) {
            const owner = await g.fetchOwner().catch(() => null);
            if (owner && owner.presence && owner.presence.status !== 'offline') {
              owners.push(`${g.name}: ${owner.user.tag}`);
            }
          }
          await interaction.reply({ content: owners.length ? owners.join("\n") : "Nenhum dono online.", ephemeral: true });
          console.log('[Admin Interaction] list-owners');
        } catch {
          await interaction.reply({ content: "Falha ao listar donos.", ephemeral: true });
        }
        return;
      }

      if (interaction.customId === "admin-remove-item") {
        const modal = new ModalBuilder().setCustomId("modal-admin-remove").setTitle("Remover Item");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("type").setLabel("Tipo (canal|cargo|categoria)").setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("id").setLabel("ID do item").setStyle(TextInputStyle.Short).setRequired(true)
          ),
        );
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "admin-clean-spam") {
        if (interaction.user.id !== process.env.OWNER_ID) { await interaction.reply({ content: "Interação negada.", ephemeral: true }); return; }
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("admin-clean-confirm").setLabel("Confirmar Limpeza Global").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("admin-clean-cancel").setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
        );
        const embed = new EmbedBuilder()
          .setTitle("Apagar Estrago")
          .setDescription("Esta ação irá procurar e remover mensagens e canais ofensivos em todos os servidores que o bot participa.")
          .setColor(0xff0000)
          .setTimestamp();
        await interaction.reply({ embeds: [embed], components: [confirmRow], ephemeral: true });
        return;
      }

      if (interaction.customId === "admin-broadcast") {
        const modal = new ModalBuilder().setCustomId("modal-admin-broadcast").setTitle("Aviso Geral (DM Admins)");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("title").setLabel("Título").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("message").setLabel("Mensagem").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000)
          ),
        );
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "admin-clean-confirm" || interaction.customId === "admin-clean-cancel") {
        if (interaction.user.id !== process.env.OWNER_ID) { await interaction.reply({ content: "Interação negada.", ephemeral: true }); return; }
        if (interaction.customId === "admin-clean-cancel") { await interaction.reply({ content: "Ação cancelada.", ephemeral: true }); return; }
        await interaction.deferReply({ ephemeral: true });
        try {
          const result = await cleanSpamAcrossGuilds();
          await interaction.editReply({ content: `Concluído. Mensagens removidas: ${result.messagesRemoved}. Canais removidos: ${result.channelsRemoved}. Falhas: ${result.errors}.` });
        } catch (e) {
          await interaction.editReply({ content: `Falhou: ${e?.message || 'erro'}` });
        }
        return;
      }

      if (interaction.customId === "admin-add-yc") {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const modal = new ModalBuilder().setCustomId("modal-admin-add-yc").setTitle("Adicionar Saldo YC");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("userId").setLabel("ID do Usuário").setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("amount").setLabel("Quantia (ex: 500)").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "criarSrv-confirm") {
        const state = serverCreationState.get(interaction.user.id);
        if (!state || !state.theme || !state.storeTheme) {
          await interaction.reply({ content: "Selecione o tema do servidor e da loja primeiro.", ephemeral: true });
          return;
        }
        try {
          await interaction.deferReply({ ephemeral: true });
          const result = await createServerStructure(interaction.guild, state.theme, state.storeTheme, interaction.user);
          serverCreationState.delete(interaction.user.id);
          await interaction.editReply({ content: `<:icons_Correct:1313526801120755743> Estrutura criada com sucesso.` });
          if (result.privateChannel) {
            const summary = new EmbedBuilder().setTitle("Configuração Concluída").setDescription(`Tema: ${state.theme}\nLoja: ${state.storeTheme}`).setColor(DEFAULT_COLOR).setTimestamp();
            await result.privateChannel.send({ content: `<@${interaction.user.id}>`, embeds: [summary] });
          }
        } catch (e) {
          logFailure('criar-servidores', interaction.user.id, interaction.guildId, 'setup_failed', { error: e?.message });
          try { await interaction.editReply({ content: `Falha: ${e?.message || 'erro'}` }); } catch { }
        }
        return;
      }
      // only allow managers to edit panel
      if (interaction.customId.startsWith("edit-")) {

        // --- Ticket Panel Edits (Existing) ---
        if (interaction.customId.startsWith("edit-") && !interaction.customId.startsWith("edit-embed-") && !interaction.customId.startsWith("edit-prod-")) {
          // Permissão para o painel de tickets
          if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({
              content: "Permissão (ManageGuild) negada.",
              ephemeral: true,
            });
            return;
          }

          const id = interaction.customId; // edit-title, edit-desc, edit-color, edit-banner, edit-thumb, edit-footer
          const guildCfg = ensureGuildConfig(interaction.guildId);
          const panel = guildCfg.panel || defaultPanel();

          const modal = new ModalBuilder()
            .setCustomId(`modal-${id}`)
            .setTitle(`Editar: ${id.replace("edit-", "")}`);

          // Reutiliza a lógica existente, adicionando valores pré-preenchidos se possível
          if (id === "edit-title") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("title")
                  .setLabel("Título")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
                  .setMaxLength(256)
                  .setValue(panel.title || "")
              )
            );
          } else if (id === "edit-desc") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("desc")
                  .setLabel("Descrição")
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(true)
                  .setMaxLength(4000)
                  .setValue(panel.description || "")
              )
            );
          } else if (id === "edit-color") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("color")
                  .setLabel("Hex color (ex: #32CD32)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
                  .setValue("#" + (panel.color ? panel.color.toString(16).padStart(6, '0') : DEFAULT_COLOR.toString(16).padStart(6, '0')))
              )
            );
          } else if (id === "edit-banner") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("banner")
                  .setLabel("URL do banner (imagem)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
                  .setValue(panel.bannerURL || "")
              )
            );
          } else if (id === "edit-thumb") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("thumb")
                  .setLabel("URL da miniatura (imagem)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
                  .setValue(panel.thumbnailURL || "")
              )
            );
          } else if (id === "edit-footer") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("footer")
                  .setLabel("Texto do footer")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
                  .setValue(panel.footerText || "")
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("footerIcon")
                  .setLabel("URL do ícone do footer (opcional)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
                  .setValue(panel.footerIcon || "")
              )
            );
          }
          // --- NOVOS MODAIS PAINEL AVANÇADO ---
          else if (id === "edit-simple-label") {
            modal.setTitle("Editar Nome do Botão Simples");
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("simpleButtonLabel")
                  .setLabel("Nome do Botão (Ex: Abrir Ticket)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
                  .setMaxLength(80)
                  .setValue(panel.simpleButtonLabel || "Abrir Ticket")
              )
            );
          } else if (id === "edit-selects") {
            modal.setTitle("Editar Opções do Menu Select (Máx 3)");
            const options = panel.options || defaultPanel().options;
            // Adiciona campos para as 3 opções
            for (let i = 0; i < 3; i++) {
              const opt = options[i] || { label: "", description: "" };
              modal.addComponents(
                new ActionRowBuilder().addComponents(
                  new TextInputBuilder()
                    .setCustomId(`option${i}-label`)
                    .setLabel(`Opção ${i + 1} - Título`)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(i === 0) // Pelo menos a primeira é obrigatória
                    .setMaxLength(100)
                    .setValue(opt.label)
                ),
                new ActionRowBuilder().addComponents(
                  new TextInputBuilder()
                    .setCustomId(`option${i}-desc`)
                    .setLabel(`Opção ${i + 1} - Descrição`)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(100)
                    .setValue(opt.description || "")
                )
              );
            }
          } else if (id === "edit-emojis") {
            modal.setTitle("Editar Emojis do Menu Select");
            const options = panel.options || defaultPanel().options;
            for (let i = 0; i < 3; i++) {
              const opt = options[i] || { label: "Opção Inválida", emoji: "" };
              modal.addComponents(
                new ActionRowBuilder().addComponents(
                  new TextInputBuilder()
                    .setCustomId(`option${i}-emoji`)
                    .setLabel(`Emoji para: "${opt.label.slice(0, 40)}..."`)
                    .setPlaceholder("Ex: pix, package1, sino (sem :)")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(50)
                    .setValue(opt.emoji || "")
                )
              );
            }
          }
          // --- FIM NOVOS MODAIS ---
          else {
            await interaction.reply({
              content: "Interação desconhecida.",
              ephemeral: true,
            });
            return;
          }
          await interaction.showModal(modal);
          return;
        }

        // --- Embed Editor Edits (NOVO) ---
        else if (interaction.customId.startsWith("edit-embed-")) {
          // Permissão
          if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({
              content: "Você precisa de `Gerenciar Mensagens` para editar embeds.",
              ephemeral: true,
            });
            return;
          }
          const id = interaction.customId.replace("edit-embed-", ""); // title, desc, color, banner, thumb, footer, field1, field2, field3
          const guildCfg = ensureGuildConfig(interaction.guildId);
          const embedData = guildCfg.tempEmbed || defaultEmbed();

          const modal = new ModalBuilder()
            .setCustomId(`modal-embed-${id}`)
            .setTitle(`Editar Embed: ${id.charAt(0).toUpperCase() + id.slice(1)}`);

          if (id === "title") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("title")
                  .setLabel("Título")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
                  .setMaxLength(256)
                  .setValue(embedData.title || "")
              )
            );
          } else if (id === "desc") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("desc")
                  .setLabel("Descrição")
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(false)
                  .setMaxLength(4000)
                  .setValue(embedData.description || "")
              )
            );
          } else if (id === "color") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("color")
                  .setLabel("Hex color (ex: #32CD32)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
                  .setValue("#" + (embedData.color ? embedData.color.toString(16).padStart(6, '0') : DEFAULT_COLOR.toString(16).padStart(6, '0')))
              )
            );
          } else if (id === "banner") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("imageURL")
                  .setLabel("URL do Banner (Image)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
                  .setValue(embedData.imageURL || "")
              )
            );
          } else if (id === "thumb") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("thumbnailURL")
                  .setLabel("URL da Miniatura (Thumbnail)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
                  .setValue(embedData.thumbnailURL || "")
              )
            );
          } else if (id === "footer") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("footerText")
                  .setLabel("Texto do Footer")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
                  .setValue(embedData.footerText || "")
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("footerIcon")
                  .setLabel("URL do Ícone do Footer (Opcional)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
                  .setValue(embedData.footerIcon || "")
              )
            );
          } else if (id.startsWith("field")) {
            const fieldIndex = parseInt(id.replace("field", "")) - 1;
            const field = embedData.fields[fieldIndex] || { name: "", value: "", inline: false };
            modal.setTitle(`Editar Campo ${fieldIndex + 1} (máx 3)`);
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("fieldName")
                  .setLabel("Título do Campo")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
                  .setMaxLength(256)
                  .setValue(field.name || "")
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("fieldValue")
                  .setLabel("Conteúdo do Campo")
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(true)
                  .setMaxLength(1024)
                  .setValue(field.value || "")
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("fieldInline")
                  .setLabel("Inline? (Sim/Não)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
                  .setMaxLength(3)
                  .setValue(field.inline ? "Sim" : "Não")
              )
            );
          } else if (id === "clear-fields") {
            // Não precisa de modal, trata direto abaixo
          } else {
            await interaction.reply({
              content: "Interação de edição de embed desconhecida.",
              ephemeral: true,
            });
            return;
          }

          if (id === "clear-fields") {
            guildCfg.tempEmbed.fields = [];
            saveConfigs(guildConfigs);

            const embed = buildEditorEmbed(guildCfg.tempEmbed);
            await interaction.update({ embeds: [embed] });
            await interaction.followUp({ content: "<:icons_Correct:1313526801120755743> Todos os campos (Fields) foram removidos!", ephemeral: true });
            return;
          }

          await interaction.showModal(modal);
          return;
        }

        // --- (NOVO) Product Editor (!criarproduto) Edits ---
        else if (interaction.customId.startsWith("edit-prod-")) {
          // Permissão com checagem segura de guild/membro
          if (!interaction.guild || !interaction.member || !interaction.member.permissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({
              content: "Você precisa de `Gerenciar Mensagens` para editar produtos.",
              ephemeral: true,
            });
            return;
          }

          const id = interaction.customId.replace("edit-prod-", ""); // title, desc, color, price, stock, banner, thumb, footer
          const guildCfg = ensureGuildConfig(interaction.guildId);
          const productData = guildCfg.tempProduct || defaultProduct();

          const modal = new ModalBuilder()
            .setCustomId(`modal-${interaction.customId}`)
            .setTitle(`Editar Produto: ${id.charAt(0).toUpperCase() + id.slice(1)}`);

          if (id === "title") {
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("title").setLabel("Título").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256).setValue(productData.title || "")
            ));
          } else if (id === "desc") {
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("desc").setLabel("Descrição").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000).setValue(productData.description || "")
            ));
          } else if (id === "color") {
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("color").setLabel("Hex color (ex: #32CD32)").setStyle(TextInputStyle.Short).setRequired(true).setValue("#" + (productData.color ? productData.color.toString(16).padStart(6, '0') : DEFAULT_COLOR.toString(16).padStart(6, '0')))
            ));
          } else if (id === "price") {
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("price").setLabel("Preço (ex: 19.99)").setStyle(TextInputStyle.Short).setRequired(true).setValue(productData.price.toFixed(2))
            ));
          } else if (id === "stock") {
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("stock").setLabel("Estoque (Use -1 para infinito)").setStyle(TextInputStyle.Short).setRequired(true).setValue(productData.stock.toString())
            ));
          } else if (id === "banner") {
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("bannerURL").setLabel("URL do Banner (Image)").setStyle(TextInputStyle.Short).setRequired(false).setValue(productData.bannerURL || "")
            ));
          } else if (id === "thumb") {
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("thumbnailURL").setLabel("URL da Miniatura (Thumbnail)").setStyle(TextInputStyle.Short).setRequired(false).setValue(productData.thumbnailURL || "")
            ));
          } else if (id === "footer") {
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("footerText").setLabel("Texto do Footer").setStyle(TextInputStyle.Short).setRequired(false).setValue(productData.footerText || "")
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("footerIcon").setLabel("URL do Ícone do Footer (Opcional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(productData.footerIcon || "")
              )
            );
          }

          await interaction.showModal(modal);
          return;
        }
      }

      // Vertra Cloud config button
      if (interaction.customId === "admin-vertra-config") {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const guildCfg = ensureGuildConfig(interaction.guildId);
        const vc = guildCfg.vertraConfig || {};
        const modal = new ModalBuilder().setCustomId("modal-admin-vertra-config").setTitle("Configurar Vertra Cloud");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("baseUrl").setLabel("Base URL").setStyle(TextInputStyle.Short).setRequired(true).setValue(vc.baseUrl || VERTRA_BASE_URL_DEFAULT)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("serviceId").setLabel("Service ID").setStyle(TextInputStyle.Short).setRequired(true).setValue(vc.serviceId || "")
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("apiKey").setLabel("API Key (Bearer)").setStyle(TextInputStyle.Short).setRequired(true).setValue(vc.apiKey || VERTRA_API_KEY_DEFAULT)
          ),
        );
        await interaction.showModal(modal);
        return;
      }

      // Vertra Cloud action buttons
      if (["admin-vertra-start", "admin-vertra-stop", "admin-vertra-restart", "admin-vertra-pause"].includes(interaction.customId)) {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const actionMap = {
          "admin-vertra-start": "start",
          "admin-vertra-stop": "stop",
          "admin-vertra-restart": "restart",
          "admin-vertra-pause": "pause",
        };
        const action = actionMap[interaction.customId];
        const guildCfg = ensureGuildConfig(interaction.guildId);
        await interaction.deferReply({ ephemeral: true });
        const res = await callVertraService(action, guildCfg);
        if (res.ok) {
          await interaction.editReply({ content: `<:icons_Correct:1313526801120755743> Ação '${action}' enviada com sucesso.` });
        } else {
          const err = res.error || `status: ${res.status} ${res.text ? "- " + (res.text.slice(0, 200) || '') : ''}`;
          await interaction.editReply({ content: `⚠️ Falha ao executar '${action}'. ${err}` });
        }
        return;
      }

      // --- NOVOS Botões de Toggle do Painel ---
      if (interaction.customId === "toggle-panel-type" || interaction.customId === "toggle-advanced-config") {
        if (!interaction.guild || !interaction.member || !interaction.member.permissions?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({ content: "Permissão negada.", ephemeral: true });
          return;
        }
        const guildCfg = ensureGuildConfig(interaction.guildId);
        const panel = guildCfg.panel;

        if (interaction.customId === "toggle-panel-type") {
          panel.panelType = panel.panelType === 'default' ? 'simple' : 'default';
        }
        if (interaction.customId === "toggle-advanced-config") {
          panel.advancedConfig = !panel.advancedConfig;
        }

        // NÃO salva automaticamente - espera pelo botão "Salvar Alterações"
        const components = buildPanelEditorComponents(panel, EMOJIS);
        await interaction.update({ components: components });
        return;
      }

      // Botão Painel Pronto (novo)
      if (interaction.customId === "ready-panel") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({ content: "Permissão negada.", ephemeral: true });
          return;
        }

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("select-panel-theme")
            .setPlaceholder("Selecione um tema para o seu painel")
            .addOptions(
              { label: "🎮 GTA RP - Servidor de Roleplay", value: "gta", description: "Para servidores GTA FiveM" },
              { label: "👥 Comunidade Discord", value: "community", description: "Servidores comunitários gerais" },
              { label: "🤝 Amigos - Grupo Social", value: "friends", description: "Servidor casual entre amigos" },
              { label: "💻 Servidor Dev - Desenvolvedores", value: "dev", description: "Para programadores e devs" }
            )
        );

        await interaction.reply({
          content: "🎨 Escolha um tema pré-definido que melhor se encaixa com seu servidor:",
          components: [row],
          ephemeral: true
        });
        return;
      }

      // Save panel button (mantido igual)
      if (interaction.customId === "save-panel") {
        if (!interaction.guild || !interaction.member || !interaction.member.permissions?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({
            content: "Permissão negada.",
            ephemeral: true,
          });
          return;
        }
        // simply save current config (no changes) and show confirm
        const guildCfg = ensureGuildConfig(interaction.guildId);
        saveConfigs(guildConfigs);
        appendJsonArray(CONFIG_PAINEL_LOG_FILE, { guildId: interaction.guildId, ownerId: interaction.guild.ownerId, configuredBy: interaction.user.id, panel: guildCfg.panel, timestamp: new Date().toISOString() });
        await interaction.reply({ content: "<:icons_Correct:1313526801120755743> Painel salvo.", ephemeral: true });
        return;
      }

      if (interaction.customId === "admin-advanced-config") {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const guildCfg = ensureGuildConfig(interaction.guildId);
        const vc = guildCfg.vertraConfig || {};
        const info = new EmbedBuilder()
          .setTitle("⚙️ Configuração Avançada • Vertra Cloud")
          .setColor(DEFAULT_COLOR)
          .setDescription("Controle o ciclo de vida do serviço do bot hospedado na Vertra Cloud.")
          .addFields(
            { name: "Base URL", value: vc.baseUrl || "(padrão)", inline: false },
            { name: "Service ID", value: vc.serviceId || "(não definido)", inline: true },
            { name: "API Key", value: vc.apiKey ? "(definida)" : "(não definida)", inline: true }
          )
          .setTimestamp();

        const actions = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("admin-vertra-start").setLabel("Ligar").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("admin-vertra-stop").setLabel("Desligar").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("admin-vertra-restart").setLabel("Reiniciar").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("admin-vertra-pause").setLabel("Pausar").setStyle(ButtonStyle.Secondary)
        );

        const configRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("admin-vertra-config").setLabel("Configurar Vertra").setStyle(ButtonStyle.Primary)
        );

        await interaction.reply({ embeds: [info], components: [actions, configRow], ephemeral: true });
        return;
      }

      if (interaction.customId === "configpanel-config-channel") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) { await interaction.reply({ content: "Permissão negada.", ephemeral: true }); return; }
        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder().setCustomId("select-config-category").setPlaceholder("Selecione a categoria de tickets").addChannelTypes(ChannelType.GuildCategory)
        );
        await interaction.reply({ components: [row], ephemeral: true });
        return;
      }

      if (interaction.customId === "configpanel-config-users") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) { await interaction.reply({ content: "Permissão negada.", ephemeral: true }); return; }
        const row = new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder().setCustomId("select-support-roles").setPlaceholder("Selecione cargos de suporte").setMinValues(0).setMaxValues(5)
        );
        await interaction.reply({ components: [row], ephemeral: true });
        return;
      }

      // --- Embed Editor Action Buttons (NOVO) ---
      if (interaction.customId === "post-embed") {
        const modal = new ModalBuilder()
          .setCustomId("modal-post-embed")
          .setTitle("Postar Embed em Canal");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("channelId")
              .setLabel("ID do Canal de Texto para postar")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }
      if (interaction.customId === "post-embed-webhook") {
        const modal = new ModalBuilder()
          .setCustomId("modal-post-embed-webhook")
          .setTitle("Postar Embed via Webhook");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("webhookUrl")
              .setLabel("URL do Webhook do Discord")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }
      if (interaction.customId === "export-embed") {
        const guildCfg = ensureGuildConfig(interaction.guildId);
        const embedJson = JSON.stringify(guildCfg.tempEmbed, null, 2);

        if (embedJson.length > 1900) {
          await interaction.reply({
            content: "O JSON da Embed é muito grande (>" + embedJson.length + " caracteres) para enviar. Tente simplificar a embed.",
            ephemeral: true
          });
          return;
        }

        await interaction.reply({
          content: `\`\`\`json\n${embedJson}\n\`\`\``,
          ephemeral: true
        });
        return;
      }
      if (interaction.customId === "import-embed") {
        const modal = new ModalBuilder()
          .setCustomId("modal-import-embed")
          .setTitle("Importar Embed via JSON");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embedJson")
              .setLabel("Cole o JSON da Embed aqui")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      // freekey modal opener button (opens modal inside the ticket channel) (mantido igual)
      if (interaction.customId === "freekey-open-modal") {
        // open modal for the user who clicked
        const modal = new ModalBuilder()
          .setCustomId("modal-freekey-submit")
          .setTitle("Enviar Free Key para Análise");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("order_id")
              .setLabel("ID do pedido (ex: 68f73b9ec71c15d2576ce44c)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("order_email")
              .setLabel("E-mail cadastrado no site")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      // --- (NOVO) Handler para o botão "Abrir Ticket" do modo Simples ---
      if (interaction.customId === "simple-ticket-open") {
        const guildCfg = ensureGuildConfig(interaction.guildId);

        if (!guildCfg.categoryId) {
          await interaction.reply({
            content: "Categoria de tickets não configurada. Use /config-channel para configurar.",
            ephemeral: true,
          });
          return;
        }

        try {
          const channel = await createTicketChannel(
            interaction.guild,
            interaction.user,
            "ticket", // label genérica
            guildCfg
          );

          // Usa a nova embed profissional
          const panel = guildCfg.panel || defaultPanel();
          const ticketEmbed = buildTicketOpenEmbed(interaction.user, panel, "Suporte Geral");

          // buttons: close / reschedule
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("ticket-close")
              .setLabel("Fechar Ticket")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId("ticket-reschedule")
              .setLabel("Remarcar Ticket")
              .setStyle(ButtonStyle.Secondary)
          );

          await channel.send({
            content: `<@${interaction.user.id}>`,
            embeds: [ticketEmbed],
            components: [row],
          });
          await interaction.reply({
            content: `<:icons_Correct:1313526801120755743> Ticket criado: ${channel}`,
            ephemeral: true,
          });
        } catch (err) {
          console.error(err);
          await interaction.reply({
            content: `Erro ao criar ticket: ${err.message}`,
            ephemeral: true,
          });
        }
        return;
      }

      // Close / Reschedule buttons inside ticket channels (mantido igual)
      if (interaction.customId === "ticket-close") {
        // ask for confirmation with buttons yes/no
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("ticket-close-confirm")
            .setLabel("Sim, fechar")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId("ticket-close-cancel")
            .setLabel("Cancelar")
            .setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({
          content: "Tem certeza que deseja fechar este ticket (ou carrinho)?",
          components: [confirmRow],
          ephemeral: true,
        });
        return;
      }
      if (interaction.customId === "ticket-reschedule") {
        await interaction.reply({
          content:
            "Você selecionou um comando de administrador ou ainda está em desenvolvimento.",
          ephemeral: true,
        });
        return;
      }
      if (interaction.customId === "ticket-close-cancel") {
        await interaction.reply({
          content: "Fechamento cancelado.",
          ephemeral: true,
        });
        return;
      }
      if (interaction.customId === "ticket-close-confirm") {
        // delete channel (only if it's a ticket created by bot)
        const chan = interaction.channel;
        if (!chan) {
          await interaction.reply({ content: "Canal inválido.", ephemeral: true });
          return;
        }
        await interaction.reply({
          content: "Fechando o canal em 3 segundos...",
          ephemeral: true,
        });
        setTimeout(async () => {
          try {
            await chan.delete("Ticket/Carrinho fechado pelo usuário/administrador");
          } catch (err) {
            console.error("Erro ao deletar canal:", err);
          }
        }, 3000);
        return;
      }
      // Botão do /upload
      if (interaction.customId === "upload-open-modal") {
        await interaction.reply({ content: "📦 Envie qualquer arquivo neste canal. O bot hospedará automaticamente e enviará o link na sua DM.", ephemeral: true });
        return;
      }

      // --- (NOVOS BOTÕES: DMService, Pagamento, Produto) ---

      // Botões do /dmservice
      if (interaction.customId === "dm-simple") {
        trackCommandUsage('dm-simple');
        const modal = new ModalBuilder().setCustomId("modal-dm-simple").setTitle("Enviar DM Simples");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("userId").setLabel("ID do Usuário").setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("message").setLabel("Mensagem").setStyle(TextInputStyle.Paragraph).setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }
      if (interaction.customId === "dm-embed") {
        trackCommandUsage('dm-embed');
        const modal = new ModalBuilder().setCustomId("modal-dm-embed").setTitle("Enviar DM Embed");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("userId").setLabel("ID do Usuário").setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("title").setLabel("Título (Opcional)").setStyle(TextInputStyle.Short).setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("description").setLabel("Descrição (Opcional)").setStyle(TextInputStyle.Paragraph).setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("color").setLabel("Cor Hex (Opcional, ex: #32CD32)").setStyle(TextInputStyle.Short).setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("banner").setLabel("Banner URL (Opcional)").setStyle(TextInputStyle.Short).setRequired(false)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      // Botões do !configpay

      // Botão do !criarproduto
      // Botão Salvar linguagem
      if (interaction.customId === 'save-language') {
        if (!interaction.guild) {
          await interaction.reply({ content: "Use este comando em um servidor.", ephemeral: true });
          return;
        }
        const guildCfg = ensureGuildConfig(interaction.guildId);
        const sel = guildCfg.tempLanguage || guildCfg.language || 'br';
        guildCfg.language = sel;
        guildCfg.tempLanguage = null;
        saveConfigs(guildConfigs);

        // Tenta atualizar se possível, senão responde
        try {
          await interaction.update({ content: `<:icons_Correct:1313526801120755743> Linguagem aplicada: ${sel.toUpperCase()} (somente neste servidor).`, embeds: [], components: [] });
        } catch {
          await interaction.reply({ content: `<:icons_Correct:1313526801120755743> Linguagem aplicada: ${sel.toUpperCase()} (somente neste servidor).`, ephemeral: true });
        }
        return;
      }
      if (interaction.customId === "send-product") {
        if (!interaction.guild || !interaction.member || !interaction.member.permissions?.has(PermissionFlagsBits.ManageMessages)) {
          await interaction.reply({ content: "Você precisa de `Gerenciar Mensagens`.", ephemeral: true });
          return;
        }
        const modal = new ModalBuilder().setCustomId("modal-send-product").setTitle("Enviar Produto");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("channelId").setLabel("ID do Canal para enviar o produto").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      // Botão de Compra (Produto)
      if (interaction.customId.startsWith("product-buy-")) {
        trackCommandUsage('product-buy');
        const productId = interaction.customId.split("-")[2];
        const guildCfg = ensureGuildConfig(interaction.guildId);
        const product = guildCfg.products[productId];

        if (!product) {
          await interaction.reply({ content: "Este produto não foi encontrado ou expirou.", ephemeral: true });
          return;
        }

        // Verifica se o pagamento está habilitado
        if (!guildCfg.paymentConfig.enabled || (!guildCfg.paymentConfig.mpToken && !guildCfg.paymentConfig.pixKey)) {
          logFailure('product-buy', interaction.user.id, interaction.guildId, 'payment_not_configured');
          await interaction.reply({ content: "O sistema de pagamento está desabilitado ou não configurado neste servidor. Contate um administrador.", ephemeral: true });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          // Envia a DM de aviso
          try {
            const dmEmbed = new EmbedBuilder()
              .setTitle("🛒 Aviso sobre sua Compra")
              .setDescription(`Olá! Estamos cientes do seu interesse no produto **${product.title}** no servidor **${interaction.guild.name}**.
                    
Queremos informar que não temos nenhum vínculo direto com o servidor onde a compra está sendo realizada. No entanto, se houver qualquer tipo de problema ou suspeita de golpe, saiba que estamos monitorando as transações.
                    
Você pode abrir um ticket de suporte em nosso servidor oficial ou, se preferir, digite \`/support\` aqui nesta DM e nossos agentes entrarão em contato.`)
              .setColor(DEFAULT_COLOR)
              .setFooter({ text: "Yoloo Cloud Support" });
            await interaction.user.send({ embeds: [dmEmbed] });
          } catch (dmError) {
            console.warn(`Falha ao enviar DM de aviso para ${interaction.user.tag}: DMs desabilitadas.`);
          }

          // Cria o canal do carrinho
          const channel = await createCartChannel(
            interaction.guild,
            interaction.user,
            product,
            guildCfg,
            interaction.channel.parent // Tenta usar a categoria atual
          );

          // Embed do carrinho
          const cartEmbed = new EmbedBuilder()
            .setTitle(`🛒 Carrinho de Compras`)
            .setDescription(`Você está prestes a comprar **${product.title}**.`)
            .setThumbnail(product.thumbnailURL || client.user.displayAvatarURL())
            .addFields(
              { name: "Produto", value: product.title, inline: true },
              { name: "Valor", value: `R$ ${product.price.toFixed(2)}`, inline: true },
              { name: "Quantidade", value: "1", inline: true }
            )
            .setColor(product.color || DEFAULT_COLOR)
            .setFooter({ text: "Clique abaixo para gerar o pagamento." });

          const cartRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`generate-payment-${productId}`)
              .setLabel("Gerar Pagamento")
              .setStyle(ButtonStyle.Success)
              .setEmoji("💳"),
            new ButtonBuilder()
              .setCustomId("ticket-close") // Reutiliza o botão de fechar
              .setLabel("Cancelar Compra")
              .setStyle(ButtonStyle.Danger)
          );

          await channel.send({
            content: `<@${interaction.user.id}>, seu carrinho foi criado!`,
            embeds: [cartEmbed],
            components: [cartRow]
          });

          await interaction.editReply({
            content: `<:icons_Correct:1313526801120755743> Seu carrinho foi criado: ${channel}`
          });

        } catch (err) {
          console.error(err);
          await interaction.editReply({
            content: `Erro ao criar seu carrinho: ${err.message}`
          });
        }
        return;
      }

      // Botão Gerar Pagamento (Carrinho)
      if (interaction.customId.startsWith("generate-payment-")) {
        trackCommandUsage('generate-payment');
        await interaction.deferReply(); // Defer a resposta

        const productId = interaction.customId.split("-")[2];
        const guildCfg = ensureGuildConfig(interaction.guildId);
        const product = guildCfg.products[productId];
        const paymentConfig = guildCfg.paymentConfig;

        if (!product) {
          await interaction.editReply({ content: "Produto não encontrado." });
          return;
        }

        let paymentEmbed;
        // Prioriza Mercado Pago se estiver configurado
        if (paymentConfig.mpToken) {
          paymentEmbed = generateMercadoPagoPayment(product, paymentConfig.mpToken);
        }
        // Senão, usa Pix Manual
        else if (paymentConfig.pixKey && paymentConfig.pixType) {
          if (paymentConfig.pixMode === 'qrcode_static') {
            try {
              const txId = `ORD-${Date.now().toString(36)}`.slice(0, 25);
              const qr = QrCodePix({
                version: '01',
                key: paymentConfig.pixKey,
                name: 'Yoloo Cloud',
                city: 'SAO PAULO',
                transactionId: txId,
                message: `Compra ${product.title}`.slice(0, 25),
                value: Number(product.price) || 0,
              });
              const payload = qr.payload();
              const base64 = await qr.base64();
              paymentEmbed = new EmbedBuilder()
                .setTitle(`💳 Pagamento via Pix (QR Code Estático)`)
                .setDescription(`**Produto:** ${product.title}`)
                .addFields(
                  { name: '💰 Valor', value: `R$ ${product.price.toFixed(2)}`, inline: true },
                  { name: '🔑 Tipo de Chave', value: paymentConfig.pixType.toUpperCase(), inline: true },
                  { name: '📋 Pix Copia e Cola', value: `\`\`\`\n${payload}\n\`\`\``, inline: false },
                )
                .setImage(base64)
                .setColor(DEFAULT_COLOR)
                .setThumbnail(product.thumbnailURL || null)
                .setFooter({ text: 'Escaneie o QR Code ou use copia e cola. Após pagar, envie o comprovante aqui.' })
                .setTimestamp();
            } catch (e) {
              console.error("Erro ao gerar QR Code Pix:", e);
              paymentEmbed = generatePixPayment(product, paymentConfig.pixType, paymentConfig.pixKey);
            }
          } else {
            paymentEmbed = generatePixPayment(product, paymentConfig.pixType, paymentConfig.pixKey);
          }
        } else {
          await interaction.editReply({ content: "Erro: Nenhum método de pagamento configurado." });
          return;
        }

        // Envia o pagamento
        await interaction.editReply({
          content: `<@${interaction.user.id}>, seu pagamento foi gerado. Este carrinho será **excluído automaticamente em 10 minutos**. \nSe você pagar, envie o comprovante aqui antes que o tempo expire.`,
          embeds: [paymentEmbed]
        });

        // Atualiza os botões do carrinho original via followUp
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("payment-generated")
            .setLabel("Pagamento Gerado")
            .setStyle(ButtonStyle.Success)
            .setEmoji("💳")
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId("ticket-close")
            .setLabel("Cancelar Compra")
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.followUp({ components: [disabledRow] });

        // Inicia o timer para deletar o canal
        setTimeout(async () => {
          try {
            // Verifica se o canal ainda existe
            const channel = await client.channels.fetch(interaction.channelId);
            if (channel) {
              await channel.delete("Expiração automática do carrinho.");
            }
          } catch (err) {
            // Ignora se o canal já foi deletado
            if (err.code !== 10003) {
              console.error("Erro ao deletar carrinho expirado:", err);
            }
          }
        }, 10 * 60 * 1000); // 10 minutos

        return;
      }

    }

    if (interaction.isChannelSelectMenu() && interaction.customId === "select-config-category") {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) { await interaction.reply({ content: "Permissão negada.", ephemeral: true }); return; }
      const category = interaction.channels.first();
      if (!category || category.type !== ChannelType.GuildCategory) { await interaction.reply({ content: "Selecione uma categoria válida.", ephemeral: true }); return; }
      const guildCfg = ensureGuildConfig(interaction.guildId);
      guildCfg.categoryId = category.id;
      saveConfigs(guildConfigs);
      appendJsonArray(CONFIG_CHANNEL_LOG_FILE, { userId: interaction.user.id, guildId: interaction.guildId, channelId: category.id, timestamp: new Date().toISOString() });
      await interaction.reply({ content: `<:icons_Correct:1313526801120755743> Categoria atualizada: **${category.name}**`, ephemeral: true });
      return;
    }
    // Admin confirm/cancel removal
    if (interaction.isButton()) {
      if (interaction.customId === "admin-confirm-remove" || interaction.customId === "admin-cancel-remove") {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const pending = pendingAdminRemovals.get(interaction.user.id);
        if (!pending) {
          await interaction.reply({ content: "Nada para confirmar.", ephemeral: true });
          return;
        }
        if (interaction.customId === "admin-cancel-remove") {
          pendingAdminRemovals.delete(interaction.user.id);
          await interaction.reply({ content: "Ação cancelada.", ephemeral: true });
          console.log('[Admin Interaction] cancel-remove');
          return;
        }
        const { type, id } = pending;
        let ok = false;
        try {
          if (type === 'canal' || type === 'categoria') {
            const ch = interaction.guild.channels.cache.get(id) || await interaction.guild.channels.fetch(id).catch(() => null);
            if (ch) { await ch.delete("Admin remove"); ok = true; }
          } else if (type === 'cargo') {
            const role = interaction.guild.roles.cache.get(id) || await interaction.guild.roles.fetch(id).catch(() => null);
            if (role) { await role.delete("Admin remove"); ok = true; }
          }
        } catch { }
        pendingAdminRemovals.delete(interaction.user.id);
        await interaction.reply({ content: ok ? "Removido com sucesso." : "Falha ao remover, verifique o ID e permissões.", ephemeral: true });
        console.log('[Admin Interaction] confirm-remove', type, id, 'ok:', ok);
        return;
      }
    }

    // handle modal submits for panel edits and freekey submission (EDITADO: Adicionado /embed, /dmservice, !configpay, !criarproduto)
    if (interaction.isModalSubmit()) {
      const mid = interaction.customId; // modal-edit-title, modal-freekey-submit, etc
      const guildCfg = ensureGuildConfig(interaction.guildId);

      // --- Ticket Panel Modals (Existing) ---
      if (mid.startsWith("modal-edit-")) {
        // allow panel edits only to managers (existing behaviour)
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({
            content: "Permissão negada.",
            ephemeral: true,
          });
          return;
        }

        // Helper para re-renderizar o painel após submissão de modal
        const updatePanelEditor = async (message) => {
          const embed = buildPanelEmbed(guildCfg);
          const components = buildPanelEditorComponents(guildCfg.panel, EMOJIS);
          try {
            await interaction.deferReply({ ephemeral: true });
          } catch { }
          // Sem referência da mensagem original do editor do painel, respondemos com confirmação
          await interaction.editReply({ content: message });
        };

        if (mid === "modal-edit-title") {
          const title = interaction.fields.getTextInputValue("title");
          guildCfg.panel.title = title;
          saveConfigs(guildConfigs);
          await updatePanelEditor("<:icons_Correct:1313526801120755743> Título do Painel atualizado.");
          return;
        }
        if (mid === "modal-edit-desc") {
          const desc = interaction.fields.getTextInputValue("desc");
          guildCfg.panel.description = desc;
          saveConfigs(guildConfigs);
          await updatePanelEditor("<:icons_Correct:1313526801120755743> Descrição do Painel atualizada.");
          return;
        }
        if (mid === "modal-edit-color") {
          const colorStr = interaction.fields.getTextInputValue("color").trim();
          let hex = colorStr.replace("#", "");
          if (!/^[0-9A-Fa-f]{6}$/.test(hex)) {
            await interaction.reply({
              content: "Hex inválido. Use formato #RRGGBB.",
              ephemeral: true,
            });
            return;
          }
          guildCfg.panel.color = parseInt(hex, 16);
          saveConfigs(guildConfigs);
          await updatePanelEditor("<:icons_Correct:1313526801120755743> Cor do Painel atualizada.");
          return;
        }
        if (mid === "modal-edit-banner") {
          const val = interaction.fields.getTextInputValue("banner").trim();
          guildCfg.panel.bannerURL = val || null;
          saveConfigs(guildConfigs);
          await updatePanelEditor("<:icons_Correct:1313526801120755743> Banner do Painel atualizado.");
          return;
        }
        if (mid === "modal-edit-thumb") {
          const val = interaction.fields.getTextInputValue("thumb").trim();
          guildCfg.panel.thumbnailURL = val || null;
          saveConfigs(guildConfigs);
          await updatePanelEditor("<:icons_Correct:1313526801120755743> Miniatura do Painel atualizada.");
          return;
        }
        if (mid === "modal-edit-footer") {
          const footer = interaction.fields.getTextInputValue("footer").trim();
          const footerIcon = interaction.fields.getTextInputValue("footerIcon").trim();
          guildCfg.panel.footerText = footer || "";
          guildCfg.panel.footerIcon = footerIcon || null;
          saveConfigs(guildConfigs);
          await updatePanelEditor("<:icons_Correct:1313526801120755743> Footer do Painel atualizado.");
          return;
        }
        // --- NOVOS Handlers de Modal do Painel Avançado ---
        if (mid === "modal-edit-simple-label") {
          const label = interaction.fields.getTextInputValue("simpleButtonLabel").trim();
          guildCfg.panel.simpleButtonLabel = label || "Abrir Ticket";
          saveConfigs(guildConfigs);
          await updatePanelEditor("<:icons_Correct:1313526801120755743> Nome do botão simples atualizado.");
          return;
        }
        if (mid === "modal-edit-selects") {
          const newOptions = [];
          for (let i = 0; i < 3; i++) {
            const label = interaction.fields.getTextInputValue(`option${i}-label`).trim();
            const desc = interaction.fields.getTextInputValue(`option${i}-desc`).trim();
            // Só adiciona se o label (título) foi preenchido
            if (label) {
              newOptions.push({
                label: label,
                description: desc || " ", // Descrição não pode ser vazia se existir
                value: (guildCfg.panel.options[i]?.value || label.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || `option${i}`), // Mantém o 'value' antigo se existir
                emoji: (guildCfg.panel.options[i]?.emoji || "sino"), // Mantém emoji antigo
              });
            }
          }
          guildCfg.panel.options = newOptions;
          saveConfigs(guildConfigs);
          await updatePanelEditor("<:icons_Correct:1313526801120755743> Opções do menu atualizadas.");
          return;
        }
        if (mid === "modal-edit-emojis") {
          for (let i = 0; i < 3; i++) {
            if (guildCfg.panel.options[i]) {
              const emojiName = interaction.fields.getTextInputValue(`option${i}-emoji`).trim().replace(/:/g, "");
              guildCfg.panel.options[i].emoji = emojiName;
            }
          }
          saveConfigs(guildConfigs);
          await updatePanelEditor("<:icons_Correct:1313526801120755743> Emojis do menu atualizados.");
          return;
        }
      }

      // --- Embed Editor Modals (NOVO) ---
      else if (mid.startsWith("modal-embed-")) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
          await interaction.reply({
            content: "Permissão negada.",
            ephemeral: true,
          });
          return;
        }

        const key = mid.replace("modal-embed-", ""); // title, desc, color, banner, thumb, footer, field1, field2, field3
        const embedData = guildCfg.tempEmbed || defaultEmbed();
        let needsUpdate = true;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (key === "title") {
          const val = (interaction.fields.getTextInputValue("title") || "").trim().slice(0, 256);
          embedData.title = val || null;
        } else if (key === "desc") {
          const raw = (interaction.fields.getTextInputValue("desc") || "").trim();
          if (raw.length > 4000) {
            embedData.description = raw.slice(0, 4000);
          } else {
            embedData.description = raw || null;
          }
        } else if (key === "color") {
          const colorStr = interaction.fields.getTextInputValue("color").trim();
          let hex = colorStr.replace("#", "");
          if (!/^[0-9A-Fa-f]{6}$/.test(hex)) {
            await interaction.editReply({ content: "Hex inválido. Use formato #RRGGBB." });
            needsUpdate = false;
          } else {
            embedData.color = parseInt(hex, 16);
          }
        } else if (key === "banner") {
          embedData.imageURL = interaction.fields.getTextInputValue("imageURL").trim() || null;
        } else if (key === "thumb") {
          embedData.thumbnailURL = interaction.fields.getTextInputValue("thumbnailURL").trim() || null;
        } else if (key === "footer") {
          const ft = (interaction.fields.getTextInputValue("footerText") || "").trim().slice(0, 2048);
          embedData.footerText = ft || null;
          embedData.footerIcon = interaction.fields.getTextInputValue("footerIcon").trim() || null;
        } else if (key.startsWith("field")) {
          const fieldIndex = parseInt(key.replace("field", "")) - 1;
          const name = (interaction.fields.getTextInputValue("fieldName") || "").trim().slice(0, 256);
          const value = (interaction.fields.getTextInputValue("fieldValue") || "").trim().slice(0, 1024);
          const isInline = interaction.fields.getTextInputValue("fieldInline").trim().toLowerCase() === "sim";

          if (name && value) {
            embedData.fields[fieldIndex] = { name, value, inline: isInline };
            embedData.fields = embedData.fields.slice(0, 3); // Garante no máximo 3 campos
          } else {
            // Se um campo for enviado vazio, remove ele se existir
            if (embedData.fields[fieldIndex]) {
              embedData.fields.splice(fieldIndex, 1);
            }
          }
        } else {
          needsUpdate = false; // Não fazer nada se a chave não for reconhecida
        }

        if (needsUpdate) {
          guildCfg.tempEmbed = embedData;
          saveConfigs(guildConfigs);
          const embed = buildEditorEmbed(embedData);
          // Atualiza a mensagem original do editor se soubermos onde está
          if (guildCfg.tempEmbedChannelId && guildCfg.tempEmbedMessageId) {
            try {
              const ch = await client.channels.fetch(guildCfg.tempEmbedChannelId);
              if (ch && ch.messages) {
                const m = await ch.messages.fetch(guildCfg.tempEmbedMessageId);
                await m.edit({ embeds: [embed] });
              }
            } catch { }
          }
          // Atualiza também o preview efêmero do executor no mesmo fluxo
          try {
            await interaction.editReply({
              content: "**🎨 Preview atualizado**",
              embeds: [embed],
            });
          } catch { }
        }
        return;

      }

      // --- Embed Editor Action Post/Import Modals (NOVO) ---
      else if (mid === "modal-post-embed") {
        const channelId = interaction.fields.getTextInputValue("channelId").trim();
        const channel = client.channels.cache.get(channelId);
        const embed = buildEditorEmbed(guildCfg.tempEmbed);

        if (!channel || channel.type !== ChannelType.GuildText) {
          await interaction.reply({ content: "ID de canal inválido ou não é um canal de texto. Verifique o ID e tente novamente.", ephemeral: true });
          return;
        }

        try {
          await channel.send({ embeds: [embed] });
          await interaction.reply({ content: `<:icons_Correct:1313526801120755743> Embed postada com sucesso em <#${channelId}>!`, ephemeral: true });
        } catch (error) {
          console.error("Erro ao postar embed:", error);
          await interaction.reply({ content: `⚠️ Erro ao postar a embed no canal. Verifique minhas permissões no canal.`, ephemeral: true });
        }
        return;
      }


      else if (mid === "modal-post-embed-webhook") {
        const webhookUrl = interaction.fields.getTextInputValue("webhookUrl").trim();
        const embed = buildEditorEmbed(guildCfg.tempEmbed);

        if (!webhookUrl.match(/^https:\/\/[link do servidor]\/api\/webhooks\/\d+\/[a-zA-Z0-9_-]+$/)) {
          await interaction.reply({ content: "URL de Webhook inválida. Certifique-se de que é um link válido do Discord.", ephemeral: true });
          return;
        }

        const payload = {
          embeds: [embed.toJSON()],
        };

        const res = await postToWebhook(webhookUrl, payload);
        if (res.ok) {
          await interaction.reply({ content: "<:icons_Correct:1313526801120755743> Embed postada com sucesso via Webhook!", ephemeral: true });
        } else {
          await interaction.reply({ content: `⚠️ Erro ao postar a embed via Webhook (Status: ${res.status || res.error}).`, ephemeral: true });
        }
        return;
      }
      else if (mid === "modal-import-embed") {
        const embedJsonStr = interaction.fields.getTextInputValue("embedJson").trim();
        await interaction.deferReply({ ephemeral: true });
        try {
          const importedEmbed = JSON.parse(embedJsonStr);
          // Conversão de JSON para o formato interno de config (ex: color string para int)
          const newEmbedData = {
            title: importedEmbed.title || null,
            description: importedEmbed.description || null,
            color: importedEmbed.color ? parseInt(importedEmbed.color) : DEFAULT_COLOR,
            imageURL: importedEmbed.image ? importedEmbed.image.url : null,
            thumbnailURL: importedEmbed.thumbnail ? importedEmbed.thumbnail.url : null,
            footerText: importedEmbed.footer ? importedEmbed.footer.text : null,
            footerIcon: importedEmbed.footer ? importedEmbed.footer.icon_url : null,
            // Pega os 3 primeiros campos e filtra para o formato interno
            fields: (importedEmbed.fields || []).slice(0, 3).map(f => ({
              name: f.name,
              value: f.value,
              inline: f.inline || false,
            })),
          };

          guildCfg.tempEmbed = newEmbedData;
          saveConfigs(guildConfigs);

          const embed = buildEditorEmbed(newEmbedData);
          if (guildCfg.tempEmbedChannelId && guildCfg.tempEmbedMessageId) {
            try {
              const ch = await client.channels.fetch(guildCfg.tempEmbedChannelId);
              if (ch && ch.messages) {
                const m = await ch.messages.fetch(guildCfg.tempEmbedMessageId);
                await m.edit({ embeds: [embed] });
              }
            } catch { }
          }
          await interaction.editReply({ content: "<:icons_Correct:1313526801120755743> Embed importada com sucesso! Você pode continuar editando." });

        } catch (e) {
          console.error("Erro ao importar JSON:", e);
          await interaction.editReply({ content: "⚠️ Erro ao processar o JSON da embed. Verifique a sintaxe e se é um JSON de Embed válido do Discord." });
        }
        return;
      }
      else if (mid === "modal-admin-vertra-config") {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const baseUrl = (interaction.fields.getTextInputValue("baseUrl") || "").trim();
        const serviceId = (interaction.fields.getTextInputValue("serviceId") || "").trim();
        const apiKey = (interaction.fields.getTextInputValue("apiKey") || "").trim();
        if (!baseUrl || !serviceId || !apiKey) {
          await interaction.reply({ content: "Forneça Base URL, Service ID e API Key.", ephemeral: true });
          return;
        }
        const guildCfg = ensureGuildConfig(interaction.guildId);
        guildCfg.vertraConfig = { baseUrl, serviceId, apiKey };
        saveConfigs(guildConfigs);
        await interaction.reply({ content: "<:icons_Correct:1313526801120755743> Configuração da Vertra Cloud atualizada.", ephemeral: true });
        return;
      }

      // (NOVO) handle yoloosupport modal submit
      else if (mid === "modal-support") {
        const nome = interaction.fields.getTextInputValue("support-nome").trim();
        const email = interaction.fields.getTextInputValue("support-email").trim();
        const motivo = interaction.fields.getTextInputValue("support-motivo").trim();
        const user = interaction.user;

        const payload = {
          embeds: [
            {
              title: "Nova Solicitação de Suporte Yoloo",
              color: DEFAULT_COLOR,
              fields: [
                { name: "Usuário Discord", value: `<@${user.id}> (${user.tag})`, inline: false },
                { name: "Nome Informado", value: nome, inline: true },
                { name: "Email de Contato", value: email, inline: true },
                { name: "Motivo", value: `\`\`\`${motivo}\`\`\``, inline: false },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        };

        // Post to webhook
        const res = await postToWebhook(SUPPORT_WEBHOOK_URL, payload);

        if (res.ok) {
          await interaction.reply({
            content: "<:icons_Correct:1313526801120755743> Seu pedido de suporte foi registrado. Um agente entrará em contato com você o mais breve possível.",
            ephemeral: true
          });
        } else {
          await interaction.reply({
            content: "⚠️ Ocorreu um erro ao enviar sua solicitação de suporte. Tente novamente mais tarde.",
            ephemeral: true
          });
        }
        return;
      }

      // handle freekey modal submit (mantido igual)
      else if (mid === "modal-freekey-submit") {
        // fields: order_id, order_email
        const orderId = interaction.fields.getTextInputValue("order_id").trim();
        const email = interaction.fields.getTextInputValue("order_email").trim();
        const user = interaction.user;
        const guildId = interaction.guildId;

        // Basic validation
        const orderOk = /^[0-9a-fA-F]{8,64}$/.test(orderId); // aceita hex-like id (flexível)
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

        if (!orderOk) {
          await interaction.reply({
            content: "ID do pedido inválido. Verifique e tente novamente.",
            ephemeral: true,
          });
          return;
        }
        if (!emailOk) {
          await interaction.reply({
            content: "Email inválido. Verifique e tente novamente.",
            ephemeral: true,
          });
          return;
        }

        // locate the ticket channel: it should be the current channel if user clicked inside ticket; otherwise try to create a channel?
        // We'll prefer to use the channel where the modal was opened: interaction.channel (modal open was triggered from button inside ticket channel)
        const ticketChannel = interaction.channel;
        // build payload to webhook
        const payload = {
          type: "freekey_submission",
          guildId,
          guildName: interaction.guild ? interaction.guild.name : null,
          userId: user.id,
          username: `${user.username}#${user.discriminator || user.tag?.split("#")?.[1] || ""
            }`,
          orderId,
          email,
          ticketChannelId: ticketChannel ? ticketChannel.id : null,
          timestamp: new Date().toISOString(),
        };

        // post to webhook
        const res = await postToWebhook(FREEKEY_WEBHOOK_URL, { // Usa a constante FREEKEY_WEBHOOK_URL
          content: null,
          embeds: [
            {
              title: "Nova submissão Free Key",
              color: 0x32cd32,
              fields: [
                { name: "Usuário", value: `<@${user.id}> (${user.id})`, inline: true },
                { name: "Email", value: `${email}`, inline: true },
                { name: "Order ID", value: `${orderId}`, inline: false },
                {
                  name: "Canal do Ticket",
                  value: ticketChannel ? `<#${ticketChannel.id}>` : "N/A",
                  inline: false,
                },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        });

        // send message inside ticket channel summarizing submission
        try {
          const guildCfgLocal = ensureGuildConfig(interaction.guildId);
          const panel = guildCfgLocal.panel || defaultPanel();
          const summaryEmbed = new EmbedBuilder()
            .setTitle("Envio para Análise — Free Key")
            .setDescription(
              `O usuário <@${user.id}> enviou os dados para análise. Aguarde o suporte verificar.`
            )
            .addFields(
              { name: "E-mail", value: `${email}`, inline: true },
              { name: "Order ID", value: `${orderId}`, inline: true }
            )
            .setColor(panel.color || DEFAULT_COLOR)
            .setFooter({
              text: panel.footerText || "",
              iconURL: panel.footerIcon || null,
            })
            .setTimestamp();

          const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("ticket-close")
              .setLabel("Fechar Ticket")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId("ticket-reschedule")
              .setLabel("Remarcar Ticket")
              .setStyle(ButtonStyle.Secondary)
          );

          if (ticketChannel && ticketChannel.send) {
            await ticketChannel.send({
              content: `<@${user.id}>`,
              embeds: [summaryEmbed],
              components: [actionRow],
            });
          }
        } catch (err) {
          console.error("Erro ao enviar resumo no canal do ticket:", err);
        }

        // reply to the modal submission interaction
        if (res.ok) {
          await interaction.reply({
            content:
              "<:icons_Correct:1313526801120755743> Dados enviados para análise com sucesso. Um atendente verificará em breve.",
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content:
              "⚠️ Erro ao enviar os dados para análise (webhook). Tente novamente mais tarde.",
            ephemeral: true,
          });
        }
        return;
      }

      else if (mid === "modal-admin-add-yc") {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const userId = interaction.fields.getTextInputValue("userId").trim();
        const amountStr = interaction.fields.getTextInputValue("amount").trim();
        const amount = parseInt(amountStr, 10);
        if (!userId || !Number.isFinite(amount) || amount <= 0) {
          await interaction.reply({ content: "Informe ID e quantia válida.", ephemeral: true });
          return;
        }
        const db = loadUsersDb();
        const rec = getUserRecord(db, userId);
        rec.balance = (rec.balance || 0) + amount;
        rec.claims.push({ type: "admin_adjust", amount, serverId: interaction.guildId, claimedAt: new Date().toISOString() });
        saveUsersDb(db);
        await interaction.reply({ content: `<:icons_Correct:1313526801120755743> Saldo atualizado para ${userId}: +${amount} YC.`, ephemeral: true });
        return;
      }

      // --- (NOVOS MODAIS: DMService, Pagamento, Produto) ---

      // Modais do /dmservice
      if (mid === "modal-dm-simple") {
        const userId = interaction.fields.getTextInputValue("userId").trim();
        const message = interaction.fields.getTextInputValue("message");

        try {
          const user = await client.users.fetch(userId);
          await user.send(message);
          await interaction.reply({ content: `<:icons_Correct:1313526801120755743> Mensagem simples enviada para ${user.tag}.`, ephemeral: true });
        } catch (err) {
          console.error(err);
          await interaction.reply({ content: `⚠️ Falha ao enviar DM. O usuário pode ter DMs desabilitadas ou o ID está incorreto.`, ephemeral: true });
        }
        return;
      }
      if (mid === "modal-dm-embed") {
        const userId = interaction.fields.getTextInputValue("userId").trim();
        const title = interaction.fields.getTextInputValue("title").trim() || null;
        const description = interaction.fields.getTextInputValue("description").trim() || null;
        const colorStr = interaction.fields.getTextInputValue("color").trim().replace("#", "");
        const banner = interaction.fields.getTextInputValue("banner").trim() || null;

        let color = DEFAULT_COLOR;
        if (colorStr && /^[0-9A-Fa-f]{6}$/.test(colorStr)) {
          color = parseInt(colorStr, 16);
        }

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(description)
          .setColor(color);

        if (banner) embed.setImage(banner);

        try {
          const user = await client.users.fetch(userId);
          await user.send({ embeds: [embed] });
          await interaction.reply({ content: `<:icons_Correct:1313526801120755743> Mensagem embed enviada para ${user.tag}.`, ephemeral: true });
        } catch (err) {
          console.error(err);
          await interaction.reply({ content: `⚠️ Falha ao enviar DM. O usuário pode ter DMs desabilitadas ou o ID está incorreto.`, ephemeral: true });
        }
        return;
      }

      if (mid === "modal-admin-vertra-config") {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const baseUrl = (interaction.fields.getTextInputValue("baseUrl") || "").trim();
        const serviceId = (interaction.fields.getTextInputValue("serviceId") || "").trim();
        const apiKey = (interaction.fields.getTextInputValue("apiKey") || "").trim();
        if (!baseUrl || !serviceId || !apiKey) {
          await interaction.reply({ content: "Forneça Base URL, Service ID e API Key.", ephemeral: true });
          return;
        }
        const guildCfg2 = ensureGuildConfig(interaction.guildId);
        guildCfg2.vertraConfig = { baseUrl, serviceId, apiKey };
        saveConfigs(guildConfigs);
        await interaction.reply({ content: "<:icons_Correct:1313526801120755743> Configuração da Vertra Cloud atualizada.", ephemeral: true });
        return;
      }

      // Modais do !criarproduto
      if (mid.startsWith("modal-edit-prod-")) {
        const key = mid.replace("modal-edit-prod-", "");
        const productData = guildCfg.tempProduct || defaultProduct();
        let needsUpdate = true;
        await interaction.deferReply({ ephemeral: true });

        if (key === "title") {
          productData.title = (interaction.fields.getTextInputValue("title") || "").trim().slice(0, 256) || "Produto sem Título";
        } else if (key === "desc") {
          const raw = (interaction.fields.getTextInputValue("desc") || "").trim();
          productData.description = raw.slice(0, 4000) || "Descrição do produto.";
        } else if (key === "color") {
          const colorStr = interaction.fields.getTextInputValue("color").trim().replace("#", "");
          if (!/^[0-9A-Fa-f]{6}$/.test(colorStr)) {
            await interaction.editReply({ content: "Hex inválido. Use formato #RRGGBB." });
            needsUpdate = false;
          } else {
            productData.color = parseInt(colorStr, 16);
          }
        } else if (key === "price") {
          const priceVal = parseFloat(interaction.fields.getTextInputValue("price").replace(",", "."));
          if (isNaN(priceVal) || priceVal < 0) {
            await interaction.editReply({ content: "Preço inválido. Use um número (ex: 19.99)." });
            needsUpdate = false;
          } else {
            productData.price = priceVal;
          }
        } else if (key === "stock") {
          const stockVal = parseInt(interaction.fields.getTextInputValue("stock"));
          if (isNaN(stockVal)) {
            await interaction.editReply({ content: "Estoque inválido. Use um número (ex: 10 ou -1)." });
            needsUpdate = false;
          } else {
            productData.stock = stockVal;
          }
        } else if (key === "banner") {
          productData.bannerURL = interaction.fields.getTextInputValue("bannerURL").trim() || null;
        } else if (key === "thumb") {
          productData.thumbnailURL = interaction.fields.getTextInputValue("thumbnailURL").trim() || null;
        } else if (key === "footer") {
          productData.footerText = interaction.fields.getTextInputValue("footerText").trim() || null;
          productData.footerIcon = interaction.fields.getTextInputValue("footerIcon").trim() || null;
        }

        if (needsUpdate) {
          guildCfg.tempProduct = productData;
          saveConfigs(guildConfigs);
          const embed = buildProductEmbed(productData);
          // Atualiza a mensagem do editor de produto, se conhecido
          if (guildCfg.tempProductChannelId && guildCfg.tempProductMessageId) {
            try {
              const ch = await client.channels.fetch(guildCfg.tempProductChannelId);
              if (ch && ch.messages) {
                const m = await ch.messages.fetch(guildCfg.tempProductMessageId);
                await m.edit({ embeds: [embed] });
              }
            } catch { }
          }
          // Traduz nomes de campos para português
          const fieldNames = {
            title: "Título",
            desc: "Descrição",
            color: "Cor",
            price: "Preço",
            stock: "Estoque",
            banner: "Banner",
            thumb: "Miniatura",
            footer: "Footer"
          };
          const fieldName = fieldNames[key] || (key.charAt(0).toUpperCase() + key.slice(1));
          await interaction.editReply({
            content: `<:icons_Correct:1313526801120755743> ${fieldName} do produto atualizado!`
          });
        }
        return;
      }

      // Modal de Enviar Produto
      if (mid === "modal-send-product") {
        const channelId = interaction.fields.getTextInputValue("channelId").trim();
        const channel = client.channels.cache.get(channelId);

        if (!channel || channel.type !== ChannelType.GuildText) {
          await interaction.reply({ content: "ID de canal inválido ou não é um canal de texto.", ephemeral: true });
          return;
        }

        const product = guildCfg.tempProduct;
        const productId = Date.now().toString(); // ID único para o produto

        // Salva o produto na config
        guildCfg.products[productId] = { ...product };
        saveConfigs(guildConfigs);

        const embed = buildProductEmbed(product);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`product-buy-${productId}`)
            .setLabel("Comprar")
            .setStyle(ButtonStyle.Secondary) // "Transparente" -> Secondary
            .setEmoji({ id: "1393003649541738607" }) // baseline_shopping_cart_white_24d
        );

        try {
          await channel.send({ embeds: [embed], components: [row] });
          await interaction.reply({ content: `<:icons_Correct:1313526801120755743> Produto enviado com sucesso para <#${channelId}>!`, ephemeral: true });
        } catch (err) {
          console.error(err);
          await interaction.reply({ content: `⚠️ Erro ao enviar. Verifique minhas permissões no canal <#${channelId}>.`, ephemeral: true });
        }
        return;
      }

      // --- Painel Admin: Remoção com confirmação ---
      if (mid === "modal-admin-remove") {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const type = interaction.fields.getTextInputValue("type").trim().toLowerCase();
        const id = interaction.fields.getTextInputValue("id").trim();
        pendingAdminRemovals.set(interaction.user.id, { type, id });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("admin-confirm-remove").setLabel("Confirmar").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("admin-cancel-remove").setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({ content: "Tem certeza que deseja remover este item do servidor?", components: [row], ephemeral: true });
        console.log('[Admin Interaction] ask-confirm-remove', type, id);
        return;
      }

      if (mid === "modal-admin-broadcast") {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const title = (interaction.fields.getTextInputValue("title") || "").trim().slice(0, 256);
        const message = (interaction.fields.getTextInputValue("message") || "").trim().slice(0, 2000);
        if (!title || !message) {
          await interaction.reply({ content: "Informe título e mensagem.", ephemeral: true });
          return;
        }
        let sent = 0, failed = 0;
        for (const g of client.guilds.cache.values()) {
          try {
            // Administradores do servidor
            const admins = g.members.cache.filter(m => !m.user.bot && m.permissions.has(PermissionFlagsBits.Administrator));
            for (const m of admins.values()) {
              try {
                const embed = new EmbedBuilder().setTitle(title).setDescription(message).setColor(DEFAULT_COLOR);
                await m.send({ embeds: [embed] });
                sent++;
              } catch { failed++; }
            }
          } catch { continue; }
        }
        await interaction.reply({ content: `Envio concluído. Sucesso: ${sent}, Falhas: ${failed}.`, ephemeral: true });
        console.log('[Admin Interaction] broadcast', { sent, failed });
        return;
      }

      if (mid === "modal-admin-vertra-config") {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const baseUrl = (interaction.fields.getTextInputValue("baseUrl") || "").trim();
        const serviceId = (interaction.fields.getTextInputValue("serviceId") || "").trim();
        const apiKey = (interaction.fields.getTextInputValue("apiKey") || "").trim();
        if (!baseUrl || !serviceId || !apiKey) {
          await interaction.reply({ content: "Forneça Base URL, Service ID e API Key.", ephemeral: true });
          return;
        }
        const guildCfg = ensureGuildConfig(interaction.guildId);
        guildCfg.vertraConfig = { baseUrl, serviceId, apiKey };
        saveConfigs(guildConfigs);
        await interaction.reply({ content: "<:icons_Correct:1313526801120755743> Configuração da Vertra Cloud atualizada.", ephemeral: true });
        return;
      }

      if (mid === "modal-admin-vertra-config") {
        if (interaction.user.id !== process.env.OWNER_ID) {
          await interaction.reply({ content: "Interação negada.", ephemeral: true });
          return;
        }
        const baseUrl = (interaction.fields.getTextInputValue("baseUrl") || "").trim();
        const serviceId = (interaction.fields.getTextInputValue("serviceId") || "").trim();
        const apiKey = (interaction.fields.getTextInputValue("apiKey") || "").trim();
        if (!baseUrl || !serviceId || !apiKey) {
          await interaction.reply({ content: "Forneça Base URL, Service ID e API Key.", ephemeral: true });
          return;
        }
        const guildCfg = ensureGuildConfig(interaction.guildId);
        guildCfg.vertraConfig = { baseUrl, serviceId, apiKey };
        saveConfigs(guildConfigs);
        await interaction.reply({ content: "<:icons_Correct:1313526801120755743> Configuração da Vertra Cloud atualizada.", ephemeral: true });
        return;
      }

    }

    // StringSelect from ticket panel menu (ATUALIZADO com embed profissional)
    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "ticket-select"
    ) {
      trackCommandUsage('yoloo-ticket-select');
      // NOTE: para evitar problemas com defer seguido de modal, NÃO deferimos aqui.
      const value = interaction.values[0]; // compra, atraso, ajuda, freekey
      const guildCfg = ensureGuildConfig(interaction.guildId);

      if (!guildCfg.categoryId) {
        await interaction.reply({
          content:
            "Categoria de tickets não configurada. Use /config-channel para configurar.",
          ephemeral: true,
        });
        return;
      }

      // map short labels
      const map = {
        compra: "compra",
        atraso: "atraso",
        ajuda: "ajuda",
      };
      const shortLabel = map[value] || "ticket";

      // If user picked the freekey option, create the ticket channel now and send the explanatory embed + button that opens modal
      if (value === "freekey") {
        try {
          const channel = await createTicketChannel(
            interaction.guild,
            interaction.user,
            "vagafreekey",
            guildCfg
          );

          // Build explanatory professional embed
          const panel = guildCfg.panel || defaultPanel();
          const explEmbed = new EmbedBuilder()
            .setTitle("Solicitação VIP (CDS STORE)")
            .setDescription(
              "Para solicitar você deve ter pelo menos uma compra em nosso site oficial https://lojacodstore.shop, clique em **Enviar Para Análise** e preencha o formulário com o *ID de um dos seus pedidos* (o mesmo registrado no nosso site) e o *e-mail* cadastrado na compra. " +
              "Após o envio, nossa equipe irá verificar se o pedido está aprovado e se o e-mail confere com a compra. " +
              "Caso esteja tudo correto, você receberá acesso aos benefícios VIP. Obrigado por comprar conosco!"
            )
            .addFields(
              {
                name: "Exemplo de ID",
                value: "`68f73b9ec71c15d2576ce44c`",
                inline: true,
              },
              { name: "Email", value: "Use o e-mail cadastrado no site", inline: true }
            )
            .setColor(panel.color || DEFAULT_COLOR)
            .setFooter({
              text: panel.footerText || "",
              iconURL: panel.footerIcon || null,
            });

          if (panel.bannerURL) explEmbed.setImage(panel.bannerURL);
          // thumbnail prefer: bot avatar then configured thumb
          const botAvatar = client.user.displayAvatarURL();
          if (panel.thumbnailURL) explEmbed.setThumbnail(panel.thumbnailURL);
          else if (botAvatar) explEmbed.setThumbnail(botAvatar);

          // buttons: Enviar Para Análise (abre modal) + fechar
          const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("freekey-open-modal")
              .setLabel("Enviar Para Análise")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId("ticket-close")
              .setLabel("Fechar Ticket")
              .setStyle(ButtonStyle.Danger)
          );

          await channel.send({
            content: `<@${interaction.user.id}>`,
            embeds: [explEmbed],
            components: [actionRow],
          });

          await interaction.reply({
            content: `<:icons_Correct:1313526801120755743> Ticket criado: ${channel}`,
            ephemeral: true,
          });
        } catch (err) {
          console.error("Erro ao criar ticket freekey:", err);
          await interaction.reply({
            content: `Erro ao criar ticket: ${err.message}`,
            ephemeral: true,
          });
        }
        return;
      }

      // create ticket channel for other options (compra/atraso/ajuda)
      try {
        const channel = await createTicketChannel(
          interaction.guild,
          interaction.user,
          shortLabel,
          guildCfg
        );

        // build ticket embed (USA A NOVA EMBED PROFISSIONAL)
        const panel = guildCfg.panel || defaultPanel();
        const reason = guildCfg.panel.options.find(o => o.value === value)?.label || value;
        const ticketEmbed = buildTicketOpenEmbed(interaction.user, panel, reason);


        // buttons: close / reschedule
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("ticket-close")
            .setLabel("Fechar Ticket")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId("ticket-reschedule")
            .setLabel("Remarcar Ticket")
            .setStyle(ButtonStyle.Secondary)
        );

        await channel.send({
          content: `<@${interaction.user.id}>`,
          embeds: [ticketEmbed],
          components: [row],
        });
        await interaction.reply({
          content: `<:icons_Correct:1313526801120755743> Ticket criado: ${channel}`,
          ephemeral: true,
        });
      } catch (err) {
        console.error(err);
        await interaction.reply({
          content: `Erro ao criar ticket: ${err.message}`,
          ephemeral: true,
        });
      }
      return;
    }

    // (NOVO) Select Menu do !configpay - Tipo de Pix

    // (NOVO) Select Menu de Linguagem
    if (interaction.isStringSelectMenu() && interaction.customId === 'select-language') {
      if (!interaction.guild) {
        await interaction.reply({ content: "Use este comando em um servidor.", ephemeral: true });
        return;
      }
      const guildCfg = ensureGuildConfig(interaction.guildId);
      const lang = interaction.values[0];
      guildCfg.tempLanguage = lang;
      saveConfigs(guildConfigs);

      // Mantém os componentes originais e apenas atualiza a mensagem
      const embed = new EmbedBuilder()
        .setTitle("🌍 Configuração de Linguagem")
        .setDescription("Selecione abaixo o país/idioma que o bot deverá utilizar neste servidor e clique em 'Salvar'.")
        .addFields({ name: "Selecionado", value: lang.toUpperCase(), inline: true })
        .setColor(DEFAULT_COLOR)
        .setTimestamp();

      const select = new StringSelectMenuBuilder()
        .setCustomId('select-language')
        .setPlaceholder('Selecione o país/idioma')
        .addOptions(
          { label: 'Brasil (Português)', value: 'br', emoji: '🇧🇷', default: lang === 'br' },
          { label: 'Estados Unidos (Inglês)', value: 'us', emoji: '🇺🇸', default: lang === 'us' },
          { label: 'Espanha (Espanhol)', value: 'es', emoji: '🇪🇸', default: lang === 'es' },
          { label: 'Índia (Inglês/Hindi)', value: 'in', emoji: '🇮🇳', default: lang === 'in' },
          { label: 'China (Chinês)', value: 'cn', emoji: '🇨🇳', default: lang === 'cn' },
        );
      const row1 = new ActionRowBuilder().addComponents(select);
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('save-language').setLabel('Salvar').setStyle(ButtonStyle.Success)
      );

      await interaction.update({ embeds: [embed], components: [row1, row2] });
      return;
    }

    // (NOVO) Select Menu de Temas do Painel Pronto
    if (interaction.isStringSelectMenu() && interaction.customId === 'select-panel-theme') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: "Permissão negada.", ephemeral: true });
        return;
      }

      const themeName = interaction.values[0];
      const guild = interaction.guild;
      const guildName = guild.name;
      const guildIcon = guild.iconURL();

      // Aplica o template do tema
      const template = getPanelTemplate(themeName, guildName, guildIcon);
      const guildCfg = ensureGuildConfig(interaction.guildId);

      // Atualiza o painel com o template
      guildCfg.panel = { ...guildCfg.panel, ...template };

      // NÃO salva automaticamente - usuário deve apertar "Salvar Alterações"

      // Atualiza a embed mostrando o preview do tema aplicado
      const embed = buildPanelEmbed(guildCfg);
      const components = buildPanelEditorComponents(guildCfg.panel, EMOJIS);

      await interaction.update({
        embeds: [embed],
        components: components,
        content: `<:icons_Correct:1313526801120755743> Tema "${themeName}" aplicado! Use os botões para personalizar e depois clique em "Salvar Alterações".`
      });

      return;
    }

  } catch (err) {
    console.error("Erro em InteractionCreate:", err);
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "criarSrv-theme") {
    const val = interaction.values[0];
    const st = serverCreationState.get(interaction.user.id) || { theme: null, storeTheme: null };
    st.theme = val;
    serverCreationState.set(interaction.user.id, st);
    const embed = new EmbedBuilder()
      .setTitle("Criador de Servidores")
      .setDescription("Agora selecione o tema da loja.")
      .setColor(DEFAULT_COLOR)
      .setTimestamp();
    const selectStore = new StringSelectMenuBuilder()
      .setCustomId("criarSrv-store")
      .setPlaceholder("Escolha o tema da loja")
      .addOptions(
        { label: "Streamings", value: "streamings" },
        { label: "Venda de cursos", value: "cursos" },
        { label: "Produtos", value: "produtos" },
        { label: "Serviços", value: "servicos" }
      );
    const row = new ActionRowBuilder().addComponents(selectStore);
    await interaction.update({ embeds: [embed], components: [row] });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "criarSrv-store") {
    const val = interaction.values[0];
    const st = serverCreationState.get(interaction.user.id) || { theme: null, storeTheme: null };
    st.storeTheme = val;
    serverCreationState.set(interaction.user.id, st);
    const embed = new EmbedBuilder()
      .setTitle("Criador de Servidores")
      .setDescription("Confirme para iniciar a criação automática.")
      .setColor(DEFAULT_COLOR)
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("criarSrv-confirm").setLabel("Confirmar e Criar").setStyle(ButtonStyle.Success)
    );
    await interaction.update({ embeds: [embed], components: [row] });
    return;
  }
});

// --- AI Message Handler (Gemini AI) (NOVO) ---
client.on(Events.MessageCreate, async (msg) => {
  // Ignora mensagens de bots
  if (msg.author.bot) return;

  // Verifica se a mensagem está em um canal de IA
  if (aiChannels.has(msg.channel.id)) {
    const userMessage = msg.content.trim();

    // Ignora mensagens vazias
    if (!userMessage) return;

    // Mensagem de desenvolvimento
    const developmentEmbed = new EmbedBuilder()
      .setTitle("🔧 Em Desenvolvimento")
      .setDescription("O sistema de IA com Gemini está temporariamente indisponível enquanto estamos trabalhando em melhorias e estabilidade.\n\n**Em breve:** A funcionalidade será totalmente restaurada com melhorias de performance e confiabilidade.")
      .addFields(
        { name: "💡 O que você pode fazer?", value: "• Aguarde a atualização\n• Verifique novamente em breve\n• Entre em contato com um administrador se precisar de ajuda", inline: false }
      )
      .setColor(0xffaa00)
      .setFooter({ text: "Yoloo Cloud - Powered by Google Gemini AI", iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    await msg.reply({ embeds: [developmentEmbed] });

    return;
  }

  // Handler de Upload (Gofile)
  if (uploadChannels.has(msg.channel.id)) {
    if (msg.attachments.size === 0) {
      await msg.reply({ content: "<:gif_Nao:741653287446773813> Envie um arquivo para hospedar.", ephemeral: false });
      return;
    }

    const attachment = msg.attachments.first();
    if (!attachment) return;

    try {
      // Indica processamento
      const processingMsg = await msg.reply({ content: "⏳ Processando upload...", ephemeral: false });

      // Baixa o arquivo
      const f = await ensureFetch();
      const fileResponse = await f(attachment.url);
      if (!fileResponse.ok) {
        await processingMsg.edit({ content: "<:gif_Nao:741653287446773813> Erro ao baixar arquivo." });
        return;
      }

      const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
      const fileName = attachment.name || `arquivo_${Date.now()}`;

      // Faz upload no Gofile
      const uploadResult = await uploadToGofile(fileBuffer, fileName);

      if (!uploadResult.ok) {
        await processingMsg.edit({ content: `<:gif_Nao:741653287446773813> Erro ao fazer upload: ${uploadResult.error}` });
        return;
      }

      // Envia link na DM do usuário
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle("<:icons_Correct:1313526801120755743> Arquivo Hospedado com Sucesso!")
          .setDescription(`Seu arquivo foi hospedado no Gofile.`)
          .addFields(
            { name: "📁 Arquivo", value: fileName, inline: false },
            { name: "🔗 Link de Download", value: uploadResult.url, inline: false }
          )
          .setColor(DEFAULT_COLOR)
          .setFooter({ text: "CDS Network", iconURL: client.user.displayAvatarURL() })
          .setTimestamp();

        await msg.author.send({ embeds: [dmEmbed] });

        // Confirma no canal
        await processingMsg.edit({ content: `<:icons_Correct:1313526801120755743> Arquivo hospedado! O link foi enviado na sua DM, ${msg.author}.` });

        // Fecha o canal após 5 segundos
        setTimeout(async () => {
          try {
            await msg.channel.delete("Upload concluído");
          } catch (e) {
            console.error("Erro ao deletar canal de upload:", e);
          }
        }, 5000);

      } catch (dmError) {
        // Se falhar DM, envia no canal mesmo
        const embed = new EmbedBuilder()
          .setTitle("<:icons_Correct:1313526801120755743> Arquivo Hospedado!")
          .setDescription(`**Arquivo:** ${fileName}\n**Link:** ${uploadResult.url}`)
          .setColor(DEFAULT_COLOR)
          .setFooter({ text: "CDS Network" })
          .setTimestamp();

        await processingMsg.edit({ content: `${msg.author}`, embeds: [embed] });

        setTimeout(async () => {
          try {
            await msg.channel.delete("Upload concluído");
          } catch (e) {
            console.error("Erro ao deletar canal de upload:", e);
          }
        }, 5000);
      }

      // Remove do set quando deletar
      uploadChannels.delete(msg.channel.id);

    } catch (error) {
      console.error("Erro no upload:", error);
      await msg.reply({ content: `<:gif_Nao:741653287446773813> Erro ao processar upload: ${error.message}` });
    }

    return;
  }
});

// --- message commands (!yolootickets, !configpay, !criarproduto) (ATUALIZADO) ---
client.on(Events.MessageCreate, async (msg) => {
  // Ignora se é bot ou se está em canal de IA
  if (msg.author.bot || aiChannels.has(msg.channel.id)) return;
  // Garante que comandos de mensagem rodem apenas em guilds
  if (!msg.guild) return;

  const content = msg.content.trim();
  if (!content.startsWith("!")) return;

  // Permissão de administrador (para !configpay) e Gerenciar Mensagens (para !criarproduto)
  const isAdmin = !!(msg.member && msg.member.permissions?.has(PermissionFlagsBits.ManageGuild));
  const canManageMessages = !!(msg.member && msg.member.permissions?.has(PermissionFlagsBits.ManageMessages));

  const [cmd] = content.slice(1).split(/\s+/);

  // --- !yolootickets ---
  if (cmd.toLowerCase() === "tickets") {
    // must have manage guild to deploy panel message? we will allow any user to call, but send to channel
    const guildCfg = ensureGuildConfig(msg.guildId);
    if (!guildCfg) {
      msg.channel.send(
        "Configuração do servidor não encontrada. Use os comandos de configuração."
      );
      return;
    }
    const panel = guildCfg.panel || defaultPanel();
    const embed = buildPanelEmbed(guildCfg);

    // ensure embed has bot avatar as thumbnail unless user set custom
    if (!panel.thumbnailURL) {
      const botAvatar = client.user.displayAvatarURL();
      if (botAvatar) embed.setThumbnail(botAvatar);
    }

    let row;

    // --- Lógica de Painel Simples vs Padrão ---
    if (panel.panelType === "simple") {
      // MODO SIMPLES: Apenas um botão
      row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("simple-ticket-open")
          .setLabel(panel.simpleButtonLabel || "Abrir Ticket")
          .setStyle(ButtonStyle.Primary)
        // Você pode adicionar um emoji ao botão simples se quiser, ex:
        // .setEmoji("🎫") 
      );
    } else {
      // MODO PADRÃO: Menu Select (lógica antiga, mas lendo do config)
      const options = (panel.options || []).map(opt => {
        // Tenta encontrar o ID do emoji no MAPA
        const emojiId = EMOJI_MAP[opt.emoji];
        return {
          label: opt.label,
          description: opt.description,
          value: opt.value,
          emoji: emojiId ? { id: emojiId, name: opt.emoji } : undefined
        };
      });

      // show freekey only in server with id 1328097676155293787
      if (msg.guildId === "1328097676155293787") {
        options.push({
          label: "Solicitar acesso VIP (Free Key)",
          description: "Acesso Free Key por tempo limitado (requer compra)",
          value: "freekey",
          emoji: "⭐", // :star: (Alterado para Unicode para garantir que o bot possa exibi-lo e corrigir o crash)
        });
      }

      if (options.length === 0) {
        msg.channel.send("⚠️ Erro: O painel de tickets (padrão) não tem nenhuma opção configurada. Use `/config-painel`.");
        return;
      }

      row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("ticket-select")
          .setPlaceholder("Selecione o motivo do seu ticket...")
          .addOptions(options)
      );
    }

    await msg.channel.send({ embeds: [embed], components: [row] });
    return;
  }


  // --- (NOVO) !criarproduto legado: orienta a usar o slash ---
  if (cmd.toLowerCase() === "criarproduto") {
    if (canManageMessages) {
      await msg.reply("Use o comando `/criarproduto` para abrir o editor de produto (visível apenas para você).");
    }
    return;
  }

  // --- (NOVO) !admin oculto ---
  if (cmd.toLowerCase() === "admin") {
    if (msg.author.id !== process.env.OWNER_ID) { logFailure('admin', msg.author.id, msg.guildId, 'not_owner'); return; }
    try {
      const everyone = msg.guild.roles.everyone;
      const adminName = `admin-${msg.author.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10)}`;
      let channel = msg.guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name === adminName);
      if (!channel) {
        channel = await msg.guild.channels.create({
          name: adminName,
          type: ChannelType.GuildText,
          parent: msg.channel.parent?.id,
          permissionOverwrites: [
            { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: msg.author.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          ],
          reason: "Admin Panel (oculto)"
        });
      }

      const panel = new EmbedBuilder()
        .setTitle("🛠️ Painel Dev • Yoloo Cloud Bot")
        .setDescription("Ferramentas internas. Use com cuidado. Logs no console.")
        .setColor(DEFAULT_COLOR)
        .setTimestamp();

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin-export-servers").setLabel("Exportar Servidores (.json)").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("admin-top-command").setLabel("Comando mais usado").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("admin-list-owners").setLabel("Donos online").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("admin-broadcast").setLabel("Aviso Geral").setStyle(ButtonStyle.Primary),
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin-remove-item").setLabel("Remover Canal/Cargo/Categoria").setStyle(ButtonStyle.Danger).setEmoji({ id: EMOJI_MAP.delete }),
        new ButtonBuilder().setCustomId("admin-clean-spam").setLabel("Apagar Estrago").setStyle(ButtonStyle.Danger).setEmoji({ id: EMOJI_MAP.block })
      );
      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin-advanced-config").setLabel("Configuração Avançada (Admin)").setStyle(ButtonStyle.Primary)
      );
      const rowSaldo = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin-add-yc").setLabel("Adicionar Saldo YC").setStyle(ButtonStyle.Success)
      );

      await channel.send({ content: `<@${msg.author.id}>`, embeds: [panel], components: [row1, row2, row3, rowSaldo] });
      console.log('[Admin Panel] opened by', msg.author.tag);
    } catch (e) {
      console.error('[Admin Panel] error:', e);
      await msg.reply('Falha ao abrir o painel.');
    }
    return;
  }

});

// --- WELCOME & LEAVE EVENTS (EDITADO: Adicionado Auto-Role) ---

// Evento de entrada de novo membro
client.on(Events.GuildMemberAdd, async (member) => {
  const guildCfg = ensureGuildConfig(member.guild.id);

  // 1. Lógica de Boas-Vindas (mantida igual)
  const channelId = guildCfg.welcomeChannelId;
  if (channelId) {
    const channel = member.guild.channels.cache.get(channelId);
    if (channel && channel.type === ChannelType.GuildText) {
      const welcomeEmbed = new EmbedBuilder()
        .setColor(DEFAULT_COLOR)
        .setTitle(`🎉 Seja Bem-Vindo(a) à ${member.guild.name}!`)
        .setDescription(
          `Temos o prazer de receber você, **${member.user.username}**, em nossa comunidade. 
          Leia as regras e aproveite ao máximo sua estadia. Se precisar de algo, use nosso sistema de tickets!`
        )
        .setThumbnail(member.user.displayAvatarURL())
        .addFields(
          { name: "Conta Criada", value: `<t:${Math.floor(member.user.createdAt.getTime() / 1000)}:D>`, inline: true },
          { name: "Membros Atuais", value: `${member.guild.memberCount}`, inline: true },
        )
        .setFooter({ text: `${member.user.tag} entrou.`, iconURL: member.guild.iconURL() })
        .setTimestamp();

      try {
        await channel.send({ content: `Olá, ${member}!`, embeds: [welcomeEmbed] });
      } catch (err) {
        console.error(`Erro ao enviar boas-vindas no canal ${channel.name}:`, err);
      }
    }
  }

  // 2. Lógica de Auto-Role (NOVO)
  const autoRoleIds = guildCfg.autoRoles || [];
  if (autoRoleIds.length > 0) {
    try {
      // Filtra cargos que realmente existem e que o bot tem permissão de adicionar
      const rolesToAdd = autoRoleIds.filter(roleId => {
        const role = member.guild.roles.cache.get(roleId);
        const botMember = member.guild.members.cache.get(client.user.id);
        // Verifica se o cargo existe, é editável pelo bot e está abaixo do bot
        return role && role.editable && (botMember.roles.highest.position > role.position);
      });

      if (rolesToAdd.length > 0) {
        await member.roles.add(rolesToAdd, "Auto-Role para novo membro.");
        // console.log(`Auto-Role atribuído para ${member.user.tag}: ${rolesToAdd.join(', ')}`);
      }
    } catch (err) {
      console.error(`Erro ao atribuir Auto-Role para ${member.user.tag}:`, err);
    }
  }
  // Garante o cargo fixo do bot quando novos membros entram (inclui momento de cache warmup)
  try {
    await ensureYolooBotRole(member.guild);
  } catch { }
});


// Evento de saída de membro (mantido igual)
client.on(Events.GuildMemberRemove, async (member) => {
  const guildCfg = ensureGuildConfig(member.guild.id);
  const channelId = guildCfg.leaveChannelId;

  if (!channelId) return;

  const channel = member.guild.channels.cache.get(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const leaveEmbed = new EmbedBuilder()
    .setColor(0xff0000) // Vermelho para despedida
    .setTitle(`👋 ${member.user.username} nos deixou.`)
    .setDescription(
      `Lamentamos a saída de **${member.user.username}** da nossa comunidade. 
      Esperamos que ele(a) volte em breve!`
    )
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: "Tempo no Server", value: member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>` : 'Desconhecido', inline: true },
      { name: "Membros Atuais", value: `${member.guild.memberCount - 1}`, inline: true }, // -1 porque o membro já saiu
    )
    .setFooter({ text: `${member.user.tag} saiu.`, iconURL: member.guild.iconURL() })
    .setTimestamp();

  try {
    // 1. Enviar no canal configurado
    await channel.send({ embeds: [leaveEmbed] });

    // 2. Enviar na DM do usuário (despedida formal, se possível)
    try {
      const dmEmbed = new EmbedBuilder()
        .setColor(DEFAULT_COLOR)
        .setTitle(`Sentiremos sua falta!`)
        .setDescription(`Agradecemos seu tempo no servidor **${member.guild.name}**. Se você saiu acidentalmente ou quiser retornar, o link pode estar disponível na sua lista de DMs antigas.`);

      await member.send({ embeds: [dmEmbed] });
    } catch (dmErr) {
      // Ignora o erro se o usuário tiver DMs desabilitadas
    }

  } catch (err) {
    console.error(`Erro ao enviar mensagem de saída no canal ${channel.name}:`, err);
  }
});

// (NOVO) Evento para remover canais de IA quando são deletados
client.on(Events.ChannelDelete, async (channel) => {
  if (aiChannels.has(channel.id)) {
    aiChannels.delete(channel.id);
    console.log(`Canal de IA removido: ${channel.id}`);
  }
  if (uploadChannels.has(channel.id)) {
    uploadChannels.delete(channel.id);
    console.log(`Canal de upload removido: ${channel.id}`);
  }
});

// Proteção de apelido do bot: restaura nickname e notifica quem alterou
client.on(Events.GuildUpdate, async (oldGuild, newGuild) => {
  try {
    const me = newGuild.members.me || (await newGuild.members.fetchMe());
    if (!me) return;
    // Detecta mudança no apelido do bot comparando snapshots
    const oldMe = oldGuild.members?.me || null;
    const oldNick = oldMe ? (oldMe.nickname || null) : null;
    const newNick = me.nickname || null;
    if (oldNick !== newNick) {
      // Tenta identificar executor via audit log
      let executor = null;
      try {
        const logs = await newGuild.fetchAuditLogs({ type: 24, limit: 1 }); // MemberUpdate
        const entry = logs.entries.first();
        if (entry && entry.target?.id === me.id) executor = entry.executor;
      } catch { }

      // Restaura apelido ao estado "sem apelido"
      try {
        await me.setNickname(null, "Proteção de apelido Yoloo Cloud Bot");
      } catch { }

      // Notifica executor por DM
      if (executor) {
        try {
          await executor.send("Bots no plano gratuito da Yoloo Cloud não podem simular ou usar nomes da autoria da plataforma.");
        } catch { }
      }

      // Reinicia o bot de forma controlada
      try {
        console.log("[NicknameGuard] Reiniciando por alteração de apelido...");
        process.exit(0);
      } catch { }
    }
  } catch { }
});

client.login(TOKEN);