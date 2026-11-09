// ================================================================
// 云响 · 动态小猫交互系统 & 登录弹窗控制器
// ================================================================

export function mountWaitingCat(stageId = 'query-wait-cat', bubbleId = 'query-cat-bubble') {
  const stage = document.getElementById(stageId);
  const bubble = document.getElementById(bubbleId);
  const image = stage?.querySelector('img');
  const source = document.getElementById('mc-cat-img');
  if (!stage || !bubble || !image || !source) return;

  image.src = source.currentSrc || source.src;
  const replies = [
    '喵，我正在逐笔核对响应和扣费记录。',
    '小爪爪翻流水中，异常记录一条也不漏。',
    '再等我一下，正在确认每笔额度有没有被扣。',
    '呼噜……我会把空回复和正常响应分清楚。',
    '找到线索啦，正在检查原站的消费凭证。',
    '别着急，我会把可申请的记录整理好。',
    '小猫巡逻中，断流记录也在认真核对。',
    '每一笔都要对得上，马上就好喵。',
    '我在盯着查询进度，没有偷偷睡着。',
    '云响正在等原站回信，我陪你一起等。',
    '检测到新数据了，正在核实是否符合规则。',
    '谢谢摸摸！我继续努力把账目查清楚。'
  ];
  let replyIndex = 1;
  stage.addEventListener('click', event => {
    event.stopPropagation();
    bubble.textContent = replies[replyIndex++ % replies.length];
    bubble.classList.remove('query-cat-bubble-pop');
    image.classList.remove('cat-bounce');
    void bubble.offsetWidth;
    bubble.classList.add('query-cat-bubble-pop');
    image.classList.add('cat-bounce');
    window.setTimeout(() => image.classList.remove('cat-bounce'), 520);
  });
}

(function () {
  // 1. 登录弹窗逻辑
  const dialog = document.getElementById("login-dialog");
  const openTop = document.getElementById("open-login-top");
  const openHero = document.getElementById("open-login-hero");
  const closeBtn = document.getElementById("close-login-dialog");

  function openDialog() {
    if (dialog && typeof dialog.showModal === "function") {
      dialog.showModal();
      const firstInput = dialog.querySelector("input:not([type=hidden])");
      if (firstInput) firstInput.focus();
    }
  }

  function closeDialog() {
    if (dialog && dialog.open) {
      dialog.close();
    }
  }

  if (openTop) openTop.addEventListener("click", openDialog);
  if (openHero) openHero.addEventListener("click", openDialog);
  if (closeBtn) closeBtn.addEventListener("click", closeDialog);

  if (dialog) {
    dialog.addEventListener("click", function (e) {
      const rect = dialog.getBoundingClientRect();
      const inDialog =
        rect.top <= e.clientY &&
        e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX &&
        e.clientX <= rect.left + rect.width;
      if (!inDialog) closeDialog();
    });
  }

  // 监听进入工作台后关闭弹窗
  const observer = new MutationObserver(function () {
    const ws = document.getElementById("workspace");
    if (ws && !ws.hidden && dialog && dialog.open) {
      dialog.close();
    }
  });
  const wsEl = document.getElementById("workspace");
  if (wsEl) observer.observe(wsEl, { attributes: true, attributeFilter: ["hidden"] });

  // 2. 动态小猫与动作回款交互
  const catStage = document.getElementById("mc-cat-stage");
  const catImg = document.getElementById("mc-cat-img");
  const bubble = document.getElementById("mc-cat-bubble");
  const bubbleText = document.getElementById("mc-cat-text");
  const coinLayer = document.getElementById("mc-coin-layer");

  if (!catStage || !bubbleText) return;

  // 至少 25 条专属台词（覆盖空回补偿、额度到账、系统保障、模型调用与治愈鼓励）
  const phrases = [
    "喵！云响正在为你全天候守护每一次模型调用 ♥",
    "刚才遇到空回复？别担心，额度马上回血到原站 ✦",
    "叮！流水比对凭证通过，一键返还到钱包余额 ☁",
    "使用原站账号直接登录，密码不落库，安全满分 🔒",
    "呼噜噜……小猫正替你紧盯每一次模型异常断流 ⚡",
    "模型偶尔打瞌睡？交给云响，空了必有回响 ♡",
    "每一笔补偿都公开透明，逐笔账本清晰可查 ✦",
    "（抖抖耳朵）捕捉到异常调用！已为你妥善记在账本上 ↗",
    "遇到复杂争议？别慌，管理员极速为你人工复核 ✦",
    "云响信条：每一份调用的期待，都值得被温柔以待 ♥",
    "掉落一枚云响金币！叮～额度自动充回原站钱包 🪙",
    "摸摸猫猫，今日代码无 Bug，创作灵感加倍爆发 ✦",
    "叮咚！为你拦截一次无效扣费，额度毫发无损 ☁",
    "调用失败不要灰心，云响时刻在背后替你撑腰 ✦",
    "常回官方交流群看看，猫猫在云边等你聊聊天 ↗",
    "记得关注通知群哦，重要维护与新模型福利不漏接 ✦",
    "空了回应，不空想念。愿你的每一次生成都有惊喜 ♡",
    "猫猫巡逻中……未发现坏数据，今日系统非常健康 ✦",
    "点击进入工作台，一键开启全自动空回体检 ↗",
    "把烦恼丢进云朵里，把额度补回钱包中 ☁",
    "喵！给每一个认真创作的你加一朵小红花 🌸",
    "小猫伸了个懒腰：无论多晚，云响都在这里守候你 ♥",
    "灵感补给完成！去模型广场挑选新的冒险搭档吧 ↗",
    "每一分额度都有据可循，用得放心才舒心 ✦",
    "小小一朵云，装得下你的奇思妙想与无限可能 ☁"
  ];

  // 动作回款金币/额度漂浮标签词库
  const refundDrops = [
    "+Quota 🪙",
    "+1000 额度",
    "+额度回血 ✦",
    "+回款到账 ✨",
    "+原站充值 ♥",
    "+灵感加倍 🌸",
    "+500 额度",
    "+安全无忧 🛡",
    "+秒级到账 ⚡"
  ];

  let currentIndex = 0;
  let isAnimating = false;

  function triggerCatInteraction(e) {
    // 1. 切换台词
    currentIndex = (currentIndex + 1) % phrases.length;
    bubbleText.textContent = phrases[currentIndex];

    // 2. 气泡轻弹跳动画
    bubble.classList.remove("bubble-pop");
    void bubble.offsetWidth; // 触发 reflow
    bubble.classList.add("bubble-pop");

    // 3. 小猫动作反馈（跳跃、欢脱）
    catImg.classList.remove("cat-bounce");
    void catImg.offsetWidth;
    catImg.classList.add("cat-bounce");

    // 4. 产生“动作回款”向上漂浮的像素金币
    if (coinLayer) {
      const coin = document.createElement("span");
      coin.className = "mc-floating-coin";
      const randomDrop = refundDrops[Math.floor(Math.random() * refundDrops.length)];
      coin.textContent = randomDrop;

      // 计算位置（靠近点击处或小猫腹部随机散落）
      const rect = catStage.getBoundingClientRect();
      const x = e ? (e.clientX - rect.left - 20) : (rect.width / 2 - 20);
      const y = e ? (e.clientY - rect.top - 20) : (rect.height / 2 - 10);

      const jitterX = (Math.random() - 0.5) * 60;
      coin.style.left = Math.max(10, Math.min(rect.width - 70, x + jitterX)) + "px";
      coin.style.top = Math.max(10, y) + "px";

      coinLayer.appendChild(coin);
      setTimeout(function () {
        if (coin.parentNode) coin.parentNode.removeChild(coin);
      }, 1000);
    }
  }

  catStage.addEventListener("click", triggerCatInteraction);
  catStage.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      triggerCatInteraction(null);
    }
  });
})();
