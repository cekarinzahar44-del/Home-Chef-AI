// Отображаемые названия тарифов (внутренние коды PRO/VIP не меняем)
const PLAN_NAMES = { FREE: 'Бесплатно', PRO: 'Стандарт', VIP: 'Про' };
const planName = (code) => PLAN_NAMES[code] || code;

module.exports = (bot, pool, ADMIN_ID) => {
  console.log('✅ Bot callbacks loaded');

  bot.action(/^approve_(\d+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒', { show_alert: true });
    try {
      const { rows: [payment] } = await pool.query(`SELECT * FROM payments WHERE id=$1`, [ctx.match[1]]);
      if (!payment) return ctx.answerCbQuery('❌', { show_alert: true });

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      await pool.query(`UPDATE subscriptions SET is_active=FALSE WHERE user_id=$1`, [payment.user_id]);
      await pool.query(
        `INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type) 
         VALUES ($1, TRUE, $2, $3)`,
        [payment.user_id, expiresAt, payment.plan_type]
      );
      await pool.query(`UPDATE users SET free_recipes_used=0 WHERE tg_id=$1`, [payment.user_id]);
      await pool.query(`UPDATE payments SET status='approved' WHERE id=$1`, [payment.id]);

      await ctx.answerCbQuery('✅ Одобрено');
      await ctx.editMessageCaption(`✅ #${payment.id} | ${planName(payment.plan_type)} активирован`, { parse_mode: 'HTML' });
      await ctx.telegram.sendMessage(
        payment.user_id,
        `🎉 <b>Подписка «${planName(payment.plan_type)}» активирована!</b>\n📅 До: ${expiresAt.toLocaleDateString('ru-RU')}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('Approve error:', e);
      await ctx.answerCbQuery('❌', { show_alert: true });
    }
  });

  bot.action(/^reject_(\d+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒', { show_alert: true });
    try {
      const { rows: [payment] } = await pool.query(`SELECT * FROM payments WHERE id=$1`, [ctx.match[1]]);
      if (!payment) return ctx.answerCbQuery('❌', { show_alert: true });

      await pool.query(`UPDATE payments SET status='rejected' WHERE id=$1`, [payment.id]);
      await ctx.answerCbQuery('❌ Отклонено');
      await ctx.editMessageCaption(`❌ #${payment.id} отклонён`, { parse_mode: 'HTML' });
      await ctx.telegram.sendMessage(
        payment.user_id,
        `❌ Оплата отклонена.\n📋 #${payment.id}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      await ctx.answerCbQuery('❌', { show_alert: true });
    }
  });
};
