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

// 📝 Sheet ayarları
const SHEET_NAME = 'Reservations'; // Google Sheet tab ismi
const DAILY_SLOTS = ["10:00", "11:00", "14:00", "15:00"];
const DAYS_AHEAD = 7;

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

/* ----------------- Yardımcı Fonksiyonlar ----------------- */

function formatDateLabel(iso) {
  try {
    const d = new Date(iso + 'T00:00:00');
    const opts = { weekday: 'short', day: '2-digit', month: 'short' };
    return d.toLocaleDateString('tr-TR', opts).replace('.', '');
  } catch {
    return iso;
  }
}

// Sheet -> Satır nesneleri
async function readAllRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A1:E`,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return [];

  const header = rows[0]; // ["Date","Time","Status","ChatID","Name"]
  const data = rows.slice(1);

  const idx = {
    date: header.indexOf('Date'),
    time: header.indexOf('Time'),
    status: header.indexOf('Status'),
    chatId: header.indexOf('ChatID'),
    name: header.indexOf('Name'),
  };

  return data.map((r, i) => ({
    row: i + 2,
    date: (r[idx.date] || '').trim(),
    time: (r[idx.time] || '').trim(),
    status: (r[idx.status] || '').trim(),
    chatId: (r[idx.chatId] || '').trim(),
    name: (r[idx.name] || '').trim(),
  }));
}

// Müsait günleri/saatleri üret → Sheet’te dolu olanları ele
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
  const booked = bookedRows.filter(r => r.status.toLowerCase() === "booked");

  for (const r of booked) {
    if (allSlots.has(r.date)) {
      const times = allSlots.get(r.date).filter(t => t !== r.time);
      allSlots.set(r.date, times);
    }
  }

  // boş günleri temizle
  for (const [d, arr] of allSlots.entries()) {
    if (arr.length === 0) allSlots.delete(d);
  }

  return allSlots;
}

// Satırı rezerve et
async function bookRow(dateISO, timeHHmm, chatId, displayName) {
  const updateRange = `${SHEET_NAME}!A:E`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: updateRange,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[dateISO, timeHHmm, 'Booked', String(chatId), displayName]]
    }
  });
  return { ok: true };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildDatesKeyboard(dates) {
  const buttons = dates.map(d => ({
    text: formatDateLabel(d),
    callback_data: `day_${d}`,
  }));
  return { inline_keyboard: chunk(buttons, 3) };
}

function buildTimesKeyboard(dateISO, times) {
  const buttons = times.map(t => ({
    text: t,
    callback_data: `slot_${dateISO}_${t}`,
  }));
  const rows = chunk(buttons, 3);
  rows.push([{ text: '↩️ Tarih seç', callback_data: 'back_dates' }]);
  return { inline_keyboard: rows };
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
    const dates = [...map.keys()];
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
      const dates = [...map.keys()];
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

      const result = await bookRow(dateISO, timeHHmm, chatId, displayName);

      if (!result.ok) {
        await bot.answerCallbackQuery(id, { text: 'Maalesef bu saat doldu.' });
        return bot.sendMessage(chatId, '❌ Bu saat dolu. Tekrar /book deneyin.');
      }

      await bot.answerCallbackQuery(id, { text: 'Rezervasyon onaylandı ✅' });
      await bot.editMessageText(
        `✅ Rezervasyonunuz onaylandı:\n📅 ${formatDateLabel(dateISO)}\n⏰ ${timeHHmm}\n\nLütfen telefon numaranızı paylaşın.`,
        { chat_id: chatId, message_id: message.message_id }
      );

      // 📞 Telefon isteme
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
    }

    await bot.answerCallbackQuery(id);
  } catch (err) {
    console.error('Callback error:', err);
    try { await bot.answerCallbackQuery(cq.id, { text: 'Hata oluştu.' }); } catch {}
    bot.sendMessage(chatId, '❌ İşlem sırasında bir hata oluştu.');
  }
});

// 📞 Telefon yakalama
bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const phone = msg.contact.phone_number;
  await bot.sendMessage(chatId, `✅ Telefon numaran alındı: ${phone}\nTeşekkürler!`);
});

// Genel mesaj (komut değilse)
bot.on('message', (msg) => {
  if (msg.contact) return; // telefon zaten yakalandı
  const text = msg.text || '';
  if (!text.startsWith('/')) {
    bot.sendMessage(msg.chat.id, 'Rezervasyon için /book yazabilirsiniz. 🙂');
  }
});
