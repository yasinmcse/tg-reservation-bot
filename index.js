const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

// 🔐 ENV
const token = process.env.BOT_TOKEN;
const sheetId = process.env.SHEET_ID;
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

// 📝 Sheet ayarları
const SHEET_NAME = 'Reservations';     // farklıysa değiştir
const RANGE_READ = `${SHEET_NAME}!A1:E`; // Date, Time, Status, ChatID, Name
const MAX_DATE_BUTTONS = 9;     // aynı anda gösterilecek gün sayısı (müsait güne göre)
const BUTTONS_PER_ROW = 3;      // satır başına kaç tarih/saat butonu

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
    const d = new Date(iso + 'T00:00:00'); // güvenli parse
    const opts = { weekday: 'short', day: '2-digit', month: 'short' };
    // Örn: "Per 25 Eyl"
    const s = d.toLocaleDateString('tr-TR', opts);
    // küçük harf sorunlarını düzelt
    return s.replace('.', '');
  } catch {
    return iso;
  }
}

// Bugünden önceki tarihleri ele
function isFutureOrToday(iso) {
  // ISO karşılaştırması güvenli (YYYY-MM-DD)
  const today = new Date();
  const tz = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
  const todayISO = tz.toISOString().slice(0, 10);
  return iso >= todayISO;
}

// Sheet -> satır nesneleri
async function readAllRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: RANGE_READ,
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

  // 1-based row number: header = row 1, data start = row 2
  return data.map((r, i) => ({
    row: i + 2,
    date: (r[idx.date] || '').trim(),
    time: (r[idx.time] || '').trim(),
    status: (r[idx.status] || '').trim(),
    chatId: (r[idx.chatId] || '').trim(),
    name: (r[idx.name] || '').trim(),
  }));
}

// Müsait günleri ve saatleri haritalandır
async function getAvailabilityMap() {
  const all = await readAllRows();

  const map = new Map(); // dateISO => [ "HH:mm", ... ]
  for (const r of all) {
    if (!r.date || !r.time) continue;
    if (!isFutureOrToday(r.date)) continue;

    // Status boş veya "Free" ise müsait kabul et
    const free = !r.status || r.status.toLowerCase() === 'free';
    const notBooked = !r.chatId && !r.name; // tamamen boş satırlar öncelikli

    if (free && notBooked) {
      if (!map.has(r.date)) map.set(r.date, []);
      map.get(r.date).push(r.time);
    }
  }

  // Saatleri sırala
  for (const [d, arr] of map.entries()) {
    arr.sort((a, b) => a.localeCompare(b));
  }

  // Günleri sırala
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

// Inline keyboard satırı oluştur
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Tarih seçimi klavyesi
function buildDatesKeyboard(dates) {
  const buttons = dates.slice(0, MAX_DATE_BUTTONS).map(d => ({
    text: formatDateLabel(d),
    callback_data: `day_${d}`,
  }));
  const rows = chunk(buttons, BUTTONS_PER_ROW);
  return { inline_keyboard: rows };
}

// Saat seçimi klavyesi
function buildTimesKeyboard(dateISO, times) {
  const buttons = times.map(t => ({
    text: t,
    callback_data: `slot_${dateISO}_${t}`,
  }));
  const rows = chunk(buttons, BUTTONS_PER_ROW);
  // Geri butonu
  rows.push([{ text: '↩️ Tarih seç', callback_data: 'back_dates' }]);
  return { inline_keyboard: rows };
}

// Satırı rezerve et (Status, ChatID, Name alanlarını yazar)
async function bookRow(dateISO, timeHHmm, chatId, displayName) {
  const all = await readAllRows();
  // Uygun satırı bul
  const candidate = all.find(r =>
    r.date === dateISO &&
    r.time === timeHHmm &&
    (!r.status || r.status.toLowerCase() === 'free') &&
    !r.chatId && !r.name
  );

  if (!candidate) {
    return { ok: false, reason: 'already_booked' };
  }

  // C:D:E hücrelerini yaz (Status, ChatID, Name)
  const updateRange = `${SHEET_NAME}!C${candidate.row}:E${candidate.row}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: updateRange,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[ 'Booked', String(chatId), displayName ]]
    }
  });

  return { ok: true, row: candidate.row };
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
    // Geri dönüş
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

    // Tarih seçimi
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

    // Saat seçimi (rezervasyon)
    if (data.startsWith('slot_')) {
      const parts = data.split('_'); // ["slot", "YYYY-MM-DD", "HH:mm"]
      const dateISO = parts[1];
      const timeHHmm = parts[2];

      const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || (from.username ? '@' + from.username : 'Unknown');

      const result = await bookRow(dateISO, timeHHmm, chatId, displayName);

      if (!result.ok && result.reason === 'already_booked') {
        await bot.answerCallbackQuery(id, { text: 'Maalesef bu saat az önce doldu.' });
        return bot.sendMessage(chatId, '❌ Maalesef bu saat az önce doldu. Lütfen tekrar /book yazın.');
      }

      await bot.answerCallbackQuery(id, { text: 'Rezervasyon onaylandı ✅' });
      return bot.editMessageText(
        `✅ Rezervasyonunuz onaylandı:\n📅 ${formatDateLabel(dateISO)}\n⏰ ${timeHHmm}\n\nGörüşmek üzere!`,
        { chat_id: chatId, message_id: message.message_id }
      );
    }

    // Diğerleri
    await bot.answerCallbackQuery(id);

  } catch (err) {
    console.error('Callback error:', err);
    try { await bot.answerCallbackQuery(cq.id, { text: 'Hata oluştu.' }); } catch {}
    bot.sendMessage(chatId, '❌ İşlem sırasında bir hata oluştu.');
  }
});

// Genel mesaj (komut değilse)
bot.on('message', (msg) => {
  const text = msg.text || '';
  if (!text.startsWith('/')) {
    bot.sendMessage(msg.chat.id, 'Rezervasyon için /book yazabilirsiniz. 🙂');
  }
});

