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

/* ----------------- i18n ----------------- */
const TRANSLATIONS = {
  tr: {
    START: 'Merhaba 👋 Rezervasyon botuna hoş geldiniz!\n\n📅 Rezervasyon için /book\n❌ İptal için /cancel',
    ASK_DATE: '📅 Lütfen bir tarih seçin:',
    NO_DATES: 'Şu an için uygun tarih bulunamadı. 🙏',
    ASK_PHONE: "📞 Rezervasyonu tamamlamak için telefon numaranı paylaşır mısın?\n\n• Aşağıdaki *📱 Numaramı paylaş* butonuna dokun\n• Ya da *+90...* formatında yaz.",
    BOOKED_CONFIRM: '✅ Rezervasyon onaylandı:\n📅 {date}\n⏰ {time}\n\n📞 Lütfen telefon numaranı paylaş.',
    CANCEL_OK: '❌ Rezervasyonun iptal edildi.',
    CANCEL_NO: '📌 İptal edilecek rezervasyon bulunamadı.',
    DEFAULT: ''
  },
  en: {
    START: 'Hello 👋 Welcome to the reservation bot!\n\n📅 Use /book to make a booking\n❌ Use /cancel to cancel a booking',
    ASK_DATE: '📅 Please pick a date:',
    NO_DATES: 'No available dates at the moment. 🙏',
    ASK_PHONE: "📞 Please share your phone number to complete the booking.\n\n• Tap *📱 Share my phone* button below\n• Or type your number in international format (+90...)",
    BOOKED_CONFIRM: '✅ Your booking is confirmed:\n📅 {date}\n⏰ {time}\n\n📞 Please share your phone number.',
    CANCEL_OK: '❌ Your booking has been cancelled.',
    CANCEL_NO: '📌 No booking found to cancel.',
    DEFAULT: ''
  },
  ru: {
    START: 'Привет 👋 Добро пожаловать в бота для бронирования!\n\n📅 Для брони используйте /book\n❌ Для отмены используйте /cancel',
    ASK_DATE: '📅 Пожалуйста, выберите дату:',
    NO_DATES: 'На данный момент нет доступных дат. 🙏',
    ASK_PHONE: "📞 Пожалуйста, поделитесь своим номером телефона, чтобы завершить бронирование.\n\n• Нажмите кнопку *📱 Поделиться номером телефона* ниже\n• Или введите номер в международном формате (+90...)",
    BOOKED_CONFIRM: '✅ Ваше бронирование подтверждено:\n📅 {date}\n⏰ {time}\n\n📞 Пожалуйста, поделитесь своим номером телефона.',
    CANCEL_OK: '❌ Ваше бронирование отменено.',
    CANCEL_NO: '📌 Нет активных бронирований для отмены.',
    DEFAULT: ''
  }
};

function userLangFrom(msg) {
  const code = (msg && msg.from && msg.from.language_code) ? String(msg.from.language_code) : '';
  if (!code) return 'en';
  const short = code.split(/[-_]/)[0];
  return TRANSLATIONS[short] ? short : 'en';
}

function t(lang, key, params = {}) {
  const dict = TRANSLATIONS[lang] || TRANSLATIONS['en'];
  let txt = dict[key] || dict['DEFAULT'] || '';
  for (const k in params) {
    txt = txt.replace(`{${k}}`, params[k]);
  }
  return txt;
}

function formatDateForLang(isoDate, lang) {
  try {
    const d = new Date(isoDate + "T00:00:00");
    return d.toLocaleDateString(lang, { weekday: "short", day: "2-digit", month: "short" });
  } catch {
    return isoDate;
  }
}

/* ----------------- Fonksiyonlar ----------------- */
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
}

async function cancelBooking(chatId) {
  const all = await readAllRows();
  const row = all.find((r) => r.chatId === String(chatId));
  if (!row) return false;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!C${row.row}:F${row.row}`,
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

function buildDatesKeyboard(dates, lang) {
  const buttons = dates.map((d) => ({
    text: formatDateForLang(d, lang),
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
  rows.push([{ text: "↩️ Back", callback_data: "back_dates" }]);
  return { inline_keyboard: rows };
}

/* ----------------- Bot Akışı ----------------- */
bot.onText(/\/start/, (msg) => {
  const lang = userLangFrom(msg);
  bot.sendMessage(msg.chat.id, t(lang, 'START'));
});

bot.onText(/\/book/, async (msg) => {
  const chatId = msg.chat.id;
  const lang = userLangFrom(msg);
  try {
    const map = await getAvailabilityMap();
    const dates = [...map.keys()];
    if (dates.length === 0) {
      return bot.sendMessage(chatId, t(lang, 'NO_DATES'));
    }
    await bot.sendMessage(chatId, t(lang, 'ASK_DATE'), {
      reply_markup: buildDatesKeyboard(dates, lang),
    });
  } catch (err) {
    console.error("Book error:", err);
    bot.sendMessage(chatId, "❌ Error loading calendar.");
  }
});

bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const lang = userLangFrom(msg);
  const ok = await cancelBooking(chatId);
  bot.sendMessage(chatId, ok ? t(lang, 'CANCEL_OK') : t(lang, 'CANCEL_NO'));
});

bot.on("callback_query", async (cq) => {
  const { id, message, data, from } = cq;
  const chatId = message.chat.id;
  const lang = userLangFrom(message);

  try {
    if (data === "back_dates") {
      const map = await getAvailabilityMap();
      const dates = [...map.keys()];
      await bot.answerCallbackQuery(id);
      return bot.editMessageText(t(lang, 'ASK_DATE'), {
        chat_id: chatId,
        message_id: message.message_id,
        reply_markup: buildDatesKeyboard(dates, lang),
      });
    }

    if (data.startsWith("day_")) {
      const dateISO = data.replace("day_", "");
      const map = await getAvailabilityMap();
      const times = map.get(dateISO) || [];
      await bot.answerCallbackQuery(id);
      return bot.editMessageText(
        `📅 ${formatDateForLang(dateISO, lang)}:`,
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

      await bot.answerCallbackQuery(id, { text: "OK" });
      await bot.editMessageText(
        t(lang, 'BOOKED_CONFIRM', {
          date: formatDateForLang(dateISO, lang),
          time: timeHHmm,
        }),
        { chat_id: chatId, message_id: message.message_id, parse_mode: "Markdown" }
      );

      await bot.sendMessage(chatId, t(lang, 'ASK_PHONE'), {
        reply_markup: {
          keyboard: [[{ text: "📱 Numaramı paylaş", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
        parse_mode: "Markdown",
      });
    }
  } catch (err) {
    console.error("Callback error:", err);
    try {
      await bot.answerCallbackQuery(cq.id, { text: "Error" });
    } catch {}
    bot.sendMessage(chatId, "❌ Error occurred.");
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
  bot.sendMessage(chatId, `✅ ${phone} kaydedildi`);
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
    return bot.sendMessage(chatId, `✅ ${phone} kaydedildi`);
  }
  if (!text.startsWith("/")) {
    const lang = userLangFrom(msg);
    bot.sendMessage(chatId, t(lang, 'START'));
  }
});
