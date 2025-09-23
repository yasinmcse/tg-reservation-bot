import express from "express";
import { Telegraf } from "telegraf";
import { google } from "googleapis";

const BOT_TOKEN = "8236706415:AAF9XXg4wqq6z6frtkdusbyNqV2C59O5Gz0";
const bot = new Telegraf(BOT_TOKEN);

const SLOTS = ["10:00", "11:00", "14:00"];

// 🔹 Google Sheets setup
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const SHEET_ID = process.env.SHEET_ID;

async function saveReservation(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Reservations!A:E",
    valueInputOption: "RAW",
    requestBody: {
      values: [row],
    },
  });
}

// --- Bot Komutları ---
bot.start(async (ctx) => {
  await saveReservation([new Date().toISOString(), ctx.chat.id, ctx.from.first_name, "/start", ""]);
  ctx.reply("Merhaba! ✅ Randevu için /book yazabilirsin.");
});

bot.command("book", (ctx) => {
  const keyboard = SLOTS.map(s => [{ text: s, callback_data: `slot_${s}` }]);
  ctx.reply("Lütfen rezervasyon için uygun zamanı seçin ⏰", {
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.on("callback_query", async (ctx) => {
  const slot = ctx.callbackQuery.data.replace("slot_", "");
  await saveReservation([new Date().toISOString(), ctx.chat.id, ctx.from.first_name, "Rezervasyon", slot]);
  ctx.answerCbQuery();
  ctx.reply(`✅ Rezervasyonunuz alındı: ${slot}`);
});

// --- Express + Webhook ---
const app = express();
app.use(express.json());
app.post("/webhook", bot.webhookCallback());
app.get("/", (_, res) => res.send("Bot çalışıyor ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT} portunda çalışıyor`));
