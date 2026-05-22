const { Markup } = require('telegraf');

module.exports = async (ctx, pool, ADMIN_ID) => {
  try {
    const { rows: stats } = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) as users,
        (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE) as subs,
        (SELECT COUNT(*) FROM payments WHERE status='pending') as pending
    `);

    const msg = `👨‍💼 <b>Панель администратора</b>\n\n` +
      `📊 <b>Статистика:</b>\n` +
      `• 👥 Пользователей: ${stats[0].users}\n` +
      `• 💎 Активных подписок: ${stats[0].subs}\n` +
      `• ⏳ Ожидающих оплат: ${stats[0].pending}\n\n` +
      `💳 Одобрение оплат — через кнопки под фото чека в этом чате.`;

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_markup: Markup.keyboard([
        ['📋 Ожидающие оплаты', '📥 Экспорт подписок'],
        ['📊 Статистика', 'ℹ️ Помощь']
      ]).resize()
    });
  } catch (e) {
    ctx.reply('❌ Ошибка: ' + e.message);
  }
};
