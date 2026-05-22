const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

module.exports = (bot, pool, ADMIN_ID) => {
  if (!ADMIN_ID) return;
  console.log(`✅ Admin handlers loaded (ID: ${ADMIN_ID})`);

  bot.hears('📋 Ожидающие оплаты', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
      const { rows } = await pool.query(`
        SELECT p.id, u.first_name, u.username, p.amount, p.plan_type, p.created_at
        FROM payments p
        JOIN users u ON p.user_id = u.tg_id
        WHERE p.status = 'pending'
        ORDER BY p.created_at DESC
        LIMIT 10
      `);
      
      if (rows.length === 0) return ctx.reply('✅ Нет ожидающих');
      
      let m = `📋 <b>Ожидающие (${rows.length}):</b>\n\n`;
      rows.forEach(r => {
        m += `<b>#${r.id}</b> — ${r.first_name} (@${r.username || '-'})\n💎 ${r.plan_type} | 💰 ${r.amount}₽\n\n`;
      });
      ctx.reply(m, { parse_mode: 'HTML' });
    } catch (e) { ctx.reply('❌ ' + e.message); }
  });

  bot.hears('📊 Статистика', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
      const { rows: s } = await pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM users) as total,
          (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE) as active,
          (SELECT SUM(amount) FROM payments WHERE status='approved') as revenue
      `);
      ctx.reply(
        `📊 <b>Статистика:</b>\n👥 ${s[0].total}\n💎 ${s[0].active}\n💰 ${s[0].revenue || 0}₽`,
        { parse_mode: 'HTML' }
      );
    } catch (e) { ctx.reply('❌ Ошибка'); }
  });

  bot.hears('ℹ️ Помощь', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.reply('📚 Одобрение оплат — через кнопки под фото чека.\n📥 Экспорт — выгрузка всех пользователей в Excel.');
  });
  // ===== EXCEL ЭКСПОРТ =====
  bot.hears('📥 Экспорт подписок', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
      await ctx.reply('⏳ Генерирую Excel...');
      const { rows } = await pool.query(`
        SELECT u.tg_id, u.username, u.first_name, u.created_at,
               s.plan_type, s.expires_at, s.is_active
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.tg_id AND s.is_active = TRUE
        ORDER BY u.created_at DESC
      `);
      
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Users');
      
      sheet.columns = [
        { header: 'TG ID', key: 'tg_id', width: 15 },
        { header: 'Username', key: 'username', width: 20 },
        { header: 'Имя', key: 'first_name', width: 20 },
        { header: 'Тариф', key: 'plan_type', width: 10 },
        { header: 'Активен', key: 'is_active', width: 10 },
        { header: 'До', key: 'expires_at', width: 15 },
        { header: 'Регистрация', key: 'created_at', width: 20 }
      ];
      
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF667EEA' }
      };
      
      rows.forEach(r => {
        sheet.addRow({
          tg_id: r.tg_id,
          username: r.username || '-',
          first_name: r.first_name || '-',
          plan_type: r.plan_type || 'FREE',
          is_active: r.is_active ? '✅' : '❌',
          expires_at: r.expires_at ? new Date(r.expires_at).toLocaleDateString('ru-RU') : '-',
          created_at: new Date(r.created_at).toLocaleString('ru-RU')
        });
      });
      
      const buffer = await workbook.xlsx.writeBuffer();
      const fileName = `users_${Date.now()}.xlsx`;
      const filePath = path.join(__dirname, fileName);
            fs.writeFileSync(filePath, buffer);
      
      await ctx.replyWithDocument(
        { source: filePath, filename: `users_${new Date().toLocaleDateString('ru-RU')}.xlsx` },
        { caption: `📊 Экспорт: ${rows.length} пользователей` }
      );
      
      fs.unlinkSync(filePath);
    } catch (e) {
      ctx.reply('❌ Ошибка: ' + e.message);
      console.error('Export error:', e);
    }
  });
};
