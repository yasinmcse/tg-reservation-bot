const express = require("express");
const app = express();
const PORT = process.env.PORT || 8080;

app.get("/", (req, res) => {
  res.send("Bot is running ✅");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

// 🔐 ENV
const token = process.env.BOT_TOKEN;
const sheetId = process.env.SHEET_ID;
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

// 📅 Otomatik tarih & saat ayarları
const DAYS_AHEAD = 7;  // kaç gün ileriye kadar slot üretilecek
const DAILY_SLOTS = ["10:00", "11:00", "14:00", "15:00"]; // her gün için saatler

// 📝 Sheet ayarları
const SHEET_NAME = 'Reservations';     
const RANGE_READ = `${SHEET_NAME}!A1:E`; 
const MAX_DATE_BUTTONS = 9;    
const BUTTONS_PER_ROW = 3;      

// ✅ Google Sheets client
const auth = new google.auth.JWT(
  serviceAccount.client_email,
  null,
  serviceAccount.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

// 🤖 Bot (polling)
const bot = new TelegramBot(token, { polling: true });

/* ----------------- Yardımcı fonksiyonlar ----------------- */

// ISO (YYYY-MM-DD) gün etiketi (tr-TR)
function formatDateLabel(iso) {
  try {
    const d = new Date(iso + 'T00:00:00');
    const opts = { weekday: 'short', day: '2-digit', month: 'short' };
    const s = d.toLocaleDateString('tr-TR', opts);
    return s.replace('.', '');
  } catch {
    return iso;
  }
}

// Sheet’teki kayıtları oku
async function readAllRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: RANGE_READ,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return [];

  const header = rows[0]; 
  const data = rows.slice(1);

  const idx = {
    date: header.indexOf('Date'),
    time: header.indexOf('Time'),
    status: header.indexOf('Status'),
    chatId: header.indexOf('ChatID'),
    name: header.indexOf('Name'),
  };

  return data.map((r, i) => ({
    date: (r[idx.date] || '').trim(),
    time: (r[idx.time] || '').trim(),
    status: (r[idx.status] || '').trim(),
    chatId: (r[idx.chatId] || '').trim(),
    name: (r[idx.name] || '').trim(),
  }));
}

// 📅 Otomatik slot üret ve doluları Sheet’ten çıkar
async function getAvailabilityMap() {
  const today = new Date();
  const allSlots = new Map();

  // Günleri ve saatleri üret
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    allSlots.set(iso, [...DAILY_SLOTS]);
  }

  // Sheet’teki dolu slotları çek
  const bookedRows = await readAllRows();
  const booked = bookedRows.filter(r => r.status.toLowerCase() === "booked");

  for (const r of booked) {
    const date = r.date;
    const time = r.time;
    if (allSlots.has(date)) {
      const times = allSlots.get(date).filter(t => t !== time);
      allSlots.set(date, times);
    }
  }

  return allSlots;
}

// Inline keyboard satırı oluştur
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildDatesKeyboard(dates) {
  const buttons = dates.slice(0, MAX_DATE_BUTTONS).map(d => ({
    text: formatDateLabel(d),
    callback_data: `day_${d}`,
  }));
  const rows = chunk(buttons, BUTTONS_PER_ROW);
  return { inline_keyboard: rows };
}

function buildTimesKeyboard(dateISO, times) {
  const buttons = times.map(t => ({
    text: t,
    callback_data: `slot_${dateISO}_${t}`,
  }));
  const rows = chunk(buttons, BUTTONS_PER_ROW);
  rows.push([{ text: '↩️ Tarih seç', callback_data: 'back_dates' }]);
  return { inline_keyboard: rows };
}

// Rezervasyonu kaydet
async function bookRow(dateISO, timeHHmm, chatId, displayName) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A:E`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[dateISO, timeHHmm, 'Booked', String(chatId), displayName]]
    }
  });
  return { ok: true };
}

/* ----------------- Komutlar / Akış ----------------- */

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Merhaba 👋 Takvimli rezervasyon botuna hoş geldiniz!\nTarih ve saat seçmek için /book yazın.'
  );
});

bot.onText(/\/book/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const map = await getAvailabilityMap();
    const dates = [...map.keys()].filter(d => (map.get(d) || []).length > 0);

    if (dates.length === 0) {
      return bot.sendMessage(chatId, 'Şu an için uygun tarih bulunamadı. 🙏');
    }

    await bot.sendMessage(
      chatId,
      '📅 Lütfen bir tarih seçin:',
      { reply_markup: buildDatesKeyboard(dates) }
    );
  } catch (err) {
    console.error('Book error:', err);
    bot.sendMessage(chatId, '❌ Takvim yüklenirken bir hata oluştu.');
  }
});

bot.on('callback_query', async (cq) => {
  const { id, message, data, from } = cq;
  const chatId = message.chat.id;

  try {
    if (data === 'back_dates') {
      const map = await getAvailabilityMap();
      const dates = [...map.keys()].filter(d => (map.get(d) || []).length > 0);

      if (dates.length === 0) {
        await bot.answerCallbackQuery(id, { text: 'Uygun tarih yok.' });
        return bot.sendMessage(chatId, 'Şu an için uygun tarih bulunamadı. 🙏');
      }
      await bot.answerCallbackQuery(id);
      return bot.editMessageText('📅 Lütfen bir tarih seçin:', {
        chat_id: chatId,
        message_id: message.message_id,
        reply_markup: buildDatesKeyboard(dates)
      });
    }

    if (data.startsWith('day_')) {
      const dateISO = data.replace('day_', '');
      const map = await getAvailabilityMap();
      const times = map.get(dateISO) || [];

      if (times.length === 0) {
        await bot.answerCallbackQuery(id, { text: 'Bu gün için uygun saat yok.' });
        return bot.editMessageText(
          `📅 ${formatDateLabel(dateISO)}: Uygun saat bulunamadı.`,
          {
            chat_id: chatId,
            message_id: message.message_id,
            reply_markup: buildDatesKeyboard([...map.keys()])
          }
        );
      }

      await bot.answerCallbackQuery(id);
      return bot.editMessageText(
        `📅 ${formatDateLabel(dateISO)} için bir saat seçin:`,
        {
          chat_id: chatId,
          message_id: message.message_id,
          reply_markup: buildTimesKeyboard(dateISO, times)
        }
      );
    }

    if (data.startsWith('slot_')) {
      const parts = data.split('_');
      const dateISO = parts[1];
      const timeHHmm = parts[2];

      const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || (from.username ? '@' + from.username : 'Unknown');

      await bookRow(dateISO, timeHHmm, chatId, displayName);

      await bot.answerCallbackQuery(id, { text: 'Rezervasyon onaylandı ✅' });
      return bot.editMessageText(
        `✅ Rezervasyonunuz onaylandı:\n📅 ${formatDateLabel(dateISO)}\n⏰ ${timeHHmm}`,
        { chat_id: chatId, message_id: message.message_id }
      );
    }

    await bot.answerCallbackQuery(id);

  } catch (err) {
    console.error('Callback error:', err);
    try { await bot.answerCallbackQuery(cq.id, { text: 'Hata oluştu.' }); } catch {}
    bot.sendMessage(chatId, '❌ İşlem sırasında bir hata oluştu.');
  }
});

bot.on('message', (msg) => {
  const text = msg.text || '';
  if (!text.startsWith('/')) {
    bot.sendMessage(msg.chat.id, 'Rezervasyon için /book yazabilirsiniz. 🙂');
  }
});
