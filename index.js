const TelegramBot = require('node-telegram-bot-api');

// Buraya kendi BOT TOKEN'INI yaz
const token = "TELEGRAM_BOT_TOKEN";

const bot = new TelegramBot(token, { polling: true });

// /start komutu
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Merhaba 👋 Render üzerinde çalışan Telegram Bot!");
});

// /book örneği
bot.onText(/\/book/, (msg) => {
  bot.sendMessage(msg.chat.id, "Rezervasyon için uygun zamanı seçin ⏰");
});

// Genel mesaj yakalama
bot.on('message', (msg) => {
  console.log("Gelen mesaj:", msg.text);
});
