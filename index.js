const express = require("express");
const app = express();
const PORT = process.env.PORT || 8080;

app.get("/", (req, res) => {
  res.send("Bot is running ✅");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");

// 🔐 ENV
const token = process.env.BOT_TOKEN;
const sheetId = process.env.SHEET_ID;
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

// 📝 Sheet ayarları
const SHEET_NAME = "Reservations";
const DAILY_SLOTS = ["10:00", "11:00", "14:00", "15:00"];
const DAYS_AHEAD = 7;

// ✅ Google Sheets client
const auth = new google.auth.JWT(
  serviceAccount.client_email,
  null,
  serviceAccount.private_key,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });

// 🤖 Bot
const bot = new TelegramBot(token, { polling: true });

/* ----------------- Fonksiyonlar ----------------- */
function formatDateLabel(iso) {
  try {
    const d = new Date(iso + "T00:00:00");
    const opts = { weekday: "short", day: "2-digit", month: "short" };
    return d.toLocaleDateString("tr-TR", opts).replace(".", "");
  } catch {
    return iso;
  }
}

async function readAllRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A1:F`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return [];
  const header = rows[0];
  const data = rows.slice(1);
  const idx = {
    date: header.indexOf("Date"),
    time: header.indexOf("Time"),
    status: header.indexOf("Status"),
    chatId: header.indexOf("ChatID"),
    name: header.indexOf("Name"),
    phone: header.indexOf("Phone"),
  };
  return data.map((r, i) => ({
    row: i + 2,
    date: (r[idx.date] || "").trim(),
    time: (r[idx.time] || "").trim(),
    status: (r[idx.status] || "").trim(),
    chatId: (r[idx.chatId] || "").trim(),
    name: (r[idx.name] || "").trim(),
    phone: (r[idx.phone] || "").trim(),
  }));
}

async function getAvailabilityMap() {
  const today = new Date();
  const allSlots = new Map();
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    allSlots.set(iso, [...DAILY_SLOTS]);
  }
  const bookedRows = await readAllRows();
  const booked = bookedRows.filter((r) => r.status.toLowerCase() === "booked");
  for (const r of booked) {
    if (allSlots.has(r.date)) {
      const times = allSlots.get(r.date).filter((t) => t !== r.time);
      allSlots.set(r.date, times);
    }
  }
  for (const [d, arr] of allSlots.entries()) {
    if (arr.length === 0) allSlots.delete(d);
  }
  return allSlots;
}

async function bookRow(dateISO, timeHHmm, chatId, displayName) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A:F`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[dateISO, timeHHmm, "Booked", String(chatId), displayName, ""]],
    },
  });
  return { ok: true };
}

async function cancelBooking(chatId) {
  const all = await readAllRows();
  const row = all.find((r) => r.chatId === String(chatId));
  if (!row) return false;
  const updateRange = `${SHEET_NAME}!C${row.row}:F${row.row}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: updateRange,
    valueInputOption: "RAW",
    requestBody: { values: [["Cancelled", "", "", ""]] },
  });
  return true;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildDatesKeyboard(dates) {
  const buttons = dates.map((d) => ({
    text: formatDateLabel(d),
    callback_data: `day_${d}`,
  }));
  return { inline_keyboard: chunk(buttons, 3) };
}

function buildTimesKeyboard(dateISO, times) {
  const buttons = times.map((t) => ({
    text: t,
    callback_data: `slot_${dateISO}_${t}`,
  }));
  const rows = chunk(buttons, 3);
  rows.push([{ text: "↩️ Tarih seç", callback_data: "back_dates" }]);
  return { inline_keyboard: rows };
}

/* ----------------- Bot Akışı ----------------- */
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Merhaba 👋 Rezervasyon botuna hoş geldiniz!\n\n📅 Rezervasyon için /book\n❌ İptal için /cancel"
  );
});

bot.onText(/\/book/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const map = await getAvailabilityMap();
    const dates = [...map.keys()];
    if (dates.length === 0) {
      return bot.sendMessage(chatId, "Şu an için uygun tarih bulunamadı. 🙏");
    }
    await bot.sendMessage(chatId, "📅 Lütfen bir tarih seçin:", {
      reply_markup: buildDatesKeyboard(dates),
    });
  } catch (err) {
    console.error("Book error:", err);
    bot.sendMessage(chatId, "❌ Takvim yüklenirken hata oluştu.");
  }
});

bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const ok = await cancelBooking(chatId);
  if (ok) bot.sendMessage(chatId, "❌ Rezervasyonun iptal edildi.");
  else bot.sendMessage(chatId, "📌 İptal edilecek rezervasyon bulunamadı.");
});

bot.on("callback_query", async (cq) => {
  const { id, message, data, from } = cq;
  const chatId = message.chat.id;
  try {
    if (data === "back_dates") {
      const map = await getAvailabilityMap();
      const dates = [...map.keys()];
      await bot.answerCallbackQuery(id);
      return bot.editMessageText("📅 Lütfen bir tarih seçin:", {
        chat_id: chatId,
        message_id: message.message_id,
        reply_markup: buildDatesKeyboard(dates),
      });
    }

    if (data.startsWith("day_")) {
      const dateISO = data.replace("day_", "");
      const map = await getAvailabilityMap();
      const times = map.get(dateISO) || [];
      await bot.answerCallbackQuery(id);
      return bot.editMessageText(
        `📅 ${formatDateLabel(dateISO)} için bir saat seçin:`,
        {
          chat_id: chatId,
          message_id: message.message_id,
          reply_markup: buildTimesKeyboard(dateISO, times),
        }
      );
    }

    if (data.startsWith("slot_")) {
      const [_, dateISO, timeHHmm] = data.split("_");
      const displayName =
        [from.first_name, from.last_name].filter(Boolean).join(" ") ||
        (from.username ? "@" + from.username : "Unknown");

      await bookRow(dateISO, timeHHmm, chatId, displayName);

      await bot.answerCallbackQuery(id, { text: "Rezervasyon onaylandı ✅" });
      await bot.editMessageText(
        `✅ Rezervasyon onaylandı:\n📅 ${formatDateLabel(
          dateISO
        )}\n⏰ ${timeHHmm}\n\n📞 Telefon numaranı paylaş.`,
        { chat_id: chatId, message_id: message.message_id }
      );

      await bot.sendMessage(
        chatId,
        "📞 Rezervasyonu tamamlamak için telefon numaranı paylaşır mısın?\n\n• Aşağıdaki 📱 **Numaramı paylaş** butonuna dokun\n• Ya da **+90...** formatında yaz.",
        {
          reply_markup: {
            keyboard: [[{ text: "📱 Numaramı paylaş", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
          parse_mode: "Markdown",
        }
      );
    }
  } catch (err) {
    console.error("Callback error:", err);
    try {
      await bot.answerCallbackQuery(id, { text: "Hata oluştu." });
    } catch {}
    bot.sendMessage(chatId, "❌ İşlem sırasında hata oluştu.");
  }
});

// 📞 Telefon butonu
bot.on("contact", async (msg) => {
  const chatId = msg.chat.id;
  const phone = msg.contact.phone_number;
  const all = await readAllRows();
  const row = all.find((r) => r.chatId === String(chatId));
  if (row) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SHEET_NAME}!F${row.row}`,
      valueInputOption: "RAW",
      requestBody: { values: [[phone]] },
    });
  }
  bot.sendMessage(chatId, `✅ Telefon kaydedildi: ${phone}`);
});

// 📞 Manuel +90 numara
bot.on("message", async (msg) => {
  if (msg.contact) return;
  const chatId = msg.chat.id;
  const text = msg.text || "";
  if (/^\+90\d{10}$/.test(text)) {
    const phone = text;
    const all = await readAllRows();
    const row = all.find((r) => r.chatId === String(chatId));
    if (row) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${SHEET_NAME}!F${row.row}`,
        valueInputOption: "RAW",
        requestBody: { values: [[phone]] },
      });
    }
    return bot.sendMessage(chatId, `✅ Telefon kaydedildi: ${phone}`);
  }
  if (!text.startsWith("/")) {
    bot.sendMessage(chatId, "Rezervasyon için /book yazabilirsiniz. 🙂");
  }
});
