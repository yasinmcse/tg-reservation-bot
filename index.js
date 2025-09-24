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
const DAYS_AHEAD = 7;  
const DAILY_SLOTS = ["10:00", "11:00", "14:00", "15:00"]; 

// 📝 Sheet ayarları
const SHEET_NAME = 'Reservations';
const RANGE_READ = `${SHEET_NAME}!A1:F`; // Date, Time, Status, ChatID, Name, Phone
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

// ⏳ Geçici bekleyen rezervasyonlar (telefon bekleniyor)
const pending = new Map(); // chatId -> { dateISO, timeHHmm, displayName }

// 📞 Basit telefon doğrulama/normalize
function normalizePhone(raw) {
  if (!raw) return "";
  let p = String(raw).trim();
  // Telegram contact '+90...' şeklinde gelir; bazıları 0 ile başlar. Sadece rakam ve + bırak.
  p = p.replace(/[^\d+]/g, "");
  // Türkiye için örnek normalize: 10 haneli ise başına +90 ekle
  if (/^\d{10}$/.test(p)) p = "+90" + p;
  // 11 haneli 0'la başlıyorsa +90'a çevir
  if (/^0\d{10}$/.test(p)) p = "+9" + p;
  return p;
}
function isLikelyPhone(p) {
  const n = normalizePhone(p);
  return /^\+?\d{10,15}$/.test(n);
}

/* ----------------- Yardımcı fonksiyonlar ----------------- */

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
    phone: header.indexOf('Phone'),
  };

  return data.map((r) => ({
    date: (r[idx.date] || '').trim(),
    time: (r[idx.time] || '').trim(),
    status: (r[idx.status] || '').trim(),
    chatId: (r[idx.chatId] || '').trim(),
    name: (r[idx.name] || '').trim(),
    phone: idx.phone >= 0 ? (r[idx.phone] || '').trim() : '',
  }));
}

// 📅 Otomatik slot üret ve doluları Sheet’ten çıkar
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
  const booked = bookedRows.filter(r => r.status && r.status.toLowerCase() === "booked");

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

// 📌 Rezervasyonu kaydet (telefon dahil)
async function bookRow(dateISO, timeHHmm, chatId, displayName, phone) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A:F`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[dateISO, timeHHmm, 'Booked', String(chatId), displayName, phone]]
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

      const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ')
        || (from.username ? '@' + from.username : 'Unknown');

      // Telefon iste: paylaş butonu + manuel giriş opsiyonu
      pending.set(chatId, { dateISO, timeHHmm, displayName });

      const sharePhoneKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "📱 Numaramı paylaş", request_contact: true }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};

await bot.sendMessage(
  chatId,
  "📞 Rezervasyonu tamamlamak için telefon numaranı paylaşır mısın?\n\n• Aşağıdaki **📱 Numaramı paylaş** butonuna dokunabilir\n• Ya da numaranı **+90...** formatında yazabilirsin.",
  { ...sharePhoneKeyboard, parse_mode: "Markdown" }
);


    await bot.answerCallbackQuery(id);

  } catch (err) {
    console.error('Callback error:', err);
    try { await bot.answerCallbackQuery(cq.id, { text: 'Hata oluştu.' }); } catch {}
    bot.sendMessage(chatId, '❌ İşlem sırasında bir hata oluştu.');
  }
});

// 📲 Kullanıcı contact objesi ile paylaştıysa
bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const pend = pending.get(chatId);
  if (!pend) {
    return bot.sendMessage(chatId, "Şu an aktif bir rezervasyon adımı bulunmuyor. /book yazarak başlayabilirsin.");
  }

  const phone = normalizePhone(msg.contact.phone_number);
  if (!isLikelyPhone(phone)) {
    return bot.sendMessage(chatId, "Telefon numarası okunamadı. Lütfen manuel olarak +90... formatında yaz.");
  }

  try {
    await bookRow(pend.dateISO, pend.timeHHmm, chatId, pend.displayName, phone);
    pending.delete(chatId);

    await bot.sendMessage(
      chatId,
      `✅ Rezervasyon tamamlandı!\n📅 ${formatDateLabel(pend.dateISO)}\n⏰ ${pend.timeHHmm}\n📞 ${phone}`,
      { reply_markup: { remove_keyboard: true } }
    );
  } catch (e) {
    console.error("Phone contact save error:", e);
    bot.sendMessage(chatId, "❌ Kayıt sırasında bir hata oluştu. Lütfen tekrar deneyin.");
  }
});

// 🔤 Kullanıcı manuel telefon yazarsa
bot.on('message', async (msg) => {
  const text = msg.text || '';
  const chatId = msg.chat.id;

  // Komut değilse ve telefon bekliyorsak
  if (!text.startsWith('/')) {
    const pend = pending.get(chatId);
    if (pend) {
      if (isLikelyPhone(text)) {
        const phone = normalizePhone(text);
        try {
          await bookRow(pend.dateISO, pend.timeHHmm, chatId, pend.displayName, phone);
          pending.delete(chatId);

          return bot.sendMessage(
            chatId,
            `✅ Rezervasyon tamamlandı!\n📅 ${formatDateLabel(pend.dateISO)}\n⏰ ${pend.timeHHmm}\n📞 ${phone}`,
            { reply_markup: { remove_keyboard: true } }
          );
        } catch (e) {
          console.error("Manual phone save error:", e);
          return bot.sendMessage(chatId, "❌ Kayıt sırasında bir hata oluştu. Lütfen tekrar deneyin.");
        }
      } else {
        // Telefon bekleniyor ama uygun format değil
        return bot.sendMessage(chatId, "Lütfen telefon numaranı **+90...** formatında yaz veya **📱 Numaramı paylaş** butonunu kullan.");
      }
    }
    // Normal serbest mesaj akışı
    return bot.sendMessage(chatId, 'Rezervasyon için /book yazabilirsiniz. 🙂');
  }
});

