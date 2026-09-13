async function showOrEdit(ctx, text, options = {}) {
  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, options);
    } catch (err) {
      // Same content / message not editable आदि होने पर नया message
      if (
        !String(err?.description || err?.message || "")
          .toLowerCase()
          .includes("message is not modified")
      ) {
        return await ctx.reply(text, options);
      }
    }
  }

  return await ctx.reply(text, options);
}

module.exports = { showOrEdit };
