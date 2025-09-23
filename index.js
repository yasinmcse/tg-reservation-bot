import express from "express";
import { Telegraf } from "telegraf";
import { google } from "googleapis";

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

// --- Slotlar ---
const SLOTS = ["10:00", "11:00", "14:00"];

// --- Google Sheets setup (JSON direkt) ---
if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
  console.error("❌ GOOGLE_SERVICE_ACCOUNT tanımlı değil!");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const SHEET_ID = process.env.SHEET_ID;

async function saveReservation(row) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Reservations!A:E",
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
    console.log("✅ Google Sheet'e kayıt eklendi:", row);
  } catch (err) {
    console.error("❌ Google Sheets hata:", err.message);
  }
}

// --- Bot Komutları ---
bot.start(async (ctx) => {
  await saveReservation([
    new Date().toISOString(),
    ctx.chat.id,
    ctx.from.first_name,
    "/start",
    ""
  ]);
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
  await saveReservation([
    new Date().toISOString(),
    ctx.chat.id,
    ctx.from.first_name,
    "Rezervasyon",
    slot
  ]);
  ctx.answerCbQuery();
  ctx.reply(`✅ Rezervasyonunuz alındı: ${slot}`);
});

// --- Express + Webhook ---
const app = express();
app.use(express.json());

app.post("/webhook", bot.webhookCallback());
app.get("/", (_, res) => res.send("Bot çalışıyor ✅"));

const PORT = 8080;
app.listen(PORT, () => console.log(`Server ${PORT} portunda çalışıyor`));
