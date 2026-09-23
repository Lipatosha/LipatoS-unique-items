const MODULE_ID = "aindor-unique-items";
const LEGACY_MODULE_IDS = ["bagryanaya-mantiya-echo"];
const ITEM_FLAG = "echoItem";
const STATE_FLAG = "echoState";
const REPLAYING = new Set();
const DEFAULT_ECHO_NAME = "Багряное эхо";

function isEchoItem(item) {
  return item?.type === "equipment" && (
    item.getFlag?.(MODULE_ID, ITEM_FLAG) === true
    || LEGACY_MODULE_IDS.some(id => item.flags?.[id]?.[ITEM_FLAG] === true)
  );
}

function getCloak(actor) {
  return actor?.items?.find(i => isEchoItem(i) && i.system.equipped);
}

function getEchoActivity(item) {
  return item?.system?.activities?.find(a =>
    a.flags?.[MODULE_ID]?.echoActivity === true
    || LEGACY_MODULE_IDS.some(id => a.flags?.[id]?.echoActivity === true)
  );
}

function getAvailableCharges(cloak) {
  const max = Number(cloak?.system?.uses?.max ?? 0);
  const spent = Number(cloak?.system?.uses?.spent ?? 0);
  return Math.max(0, max - spent);
}

function getExpiry(actor) {
  const combat = game.combat;
  if (!combat?.started) return { combatId: null };

  const turnIndex = combat.turns.findIndex(c => c.actorId === actor.id);
  if (turnIndex < 0) return { combatId: null };

  const currentTurn = Number.isInteger(combat.turn) ? combat.turn : -1;
  const currentRound = combat.round ?? 1;
  const expiryRound = currentTurn < turnIndex ? currentRound : currentRound + 1;

  return {
    combatId: combat.id,
    expiryRound,
    expiryTurn: turnIndex
  };
}

function isExpired(state) {
  if (!state?.combatId) return false;
  const combat = game.combat;
  if (!combat || combat.id !== state.combatId || !combat.started) return true;

  const round = combat.round ?? 1;
  const turn = Number.isInteger(combat.turn) ? combat.turn : -1;
  if (round > state.expiryRound) return true;
  if (round === state.expiryRound && turn > state.expiryTurn) return true;
  return false;
}

async function captureSpell(activity, usageConfig) {
  const spell = activity?.item;
  const actor = activity?.actor;
  if (!spell || !actor || spell.type !== "spell") return;
  if (REPLAYING.has(actor.id)) return;

  const baseLevel = Number(spell.system.level ?? 0);
  const scaling = Number(usageConfig?.scaling ?? 0);
  const effectiveLevel = baseLevel + scaling;
  if (effectiveLevel < 1 || effectiveLevel > 3) return;

  const cloak = getCloak(actor);
  if (!cloak || getAvailableCharges(cloak) < 1) return;

  const echoActivity = getEchoActivity(cloak);
  if (!echoActivity) return;

  const state = {
    spellItemId: spell.id,
    activityId: activity.id,
    spellName: spell.name,
    baseLevel,
    scaling,
    effectiveLevel,
    ...getExpiry(actor)
  };

  await actor.setFlag(MODULE_ID, STATE_FLAG, state);
  await cloak.update({ [`system.activities.${echoActivity.id}.name`]: `${DEFAULT_ECHO_NAME} — ${spell.name}` });
  ui.notifications.info(`Багряная мантия запомнила: ${spell.name}. Заряд: ${getAvailableCharges(cloak)}/1.`);
}

async function replayEcho(cloakActivity) {
  const cloak = cloakActivity.item;
  const actor = cloak?.actor;
  if (!cloak || !actor) return;

  if (!cloak.system.equipped) {
    ui.notifications.warn("Багряная мантия должна быть надета.");
    return;
  }
  if (getAvailableCharges(cloak) < 1) {
    ui.notifications.warn("В Багряной мантии не осталось зарядов. 1 заряд восстановится после продолжительного отдыха.");
    return;
  }

  const state = actor.getFlag(MODULE_ID, STATE_FLAG);
  if (!state) {
    if (cloakActivity.name !== DEFAULT_ECHO_NAME) {
      await cloak.update({ [`system.activities.${cloakActivity.id}.name`]: DEFAULT_ECHO_NAME });
    }
    ui.notifications.warn("Мантия ещё не запомнила заклинание 1–3 уровня.");
    return;
  }
  if (isExpired(state)) {
    await actor.unsetFlag(MODULE_ID, STATE_FLAG);
    await cloak.update({ [`system.activities.${cloakActivity.id}.name`]: DEFAULT_ECHO_NAME });
    ui.notifications.warn("Багряное эхо угасло: следующий ход уже закончился.");
    return;
  }

  const spell = actor.items.get(state.spellItemId);
  if (!spell || spell.type !== "spell") {
    await actor.unsetFlag(MODULE_ID, STATE_FLAG);
    ui.notifications.warn("Запомненное заклинание больше не найдено на персонаже.");
    return;
  }

  const spellActivity = spell.system.activities.get(state.activityId)
    ?? spell.system.activities.find(a => a.canUse);
  if (!spellActivity) {
    ui.notifications.warn("У запомненного заклинания нет доступного действия.");
    return;
  }

  REPLAYING.add(actor.id);
  try {
    const result = await spellActivity.use(
      {
        scaling: state.scaling,
        consume: { spellSlot: false }
      },
      { configure: true },
      {}
    );

    if (!result) return;

    const max = Number(cloak.system.uses?.max ?? 1);
    const spent = Math.min(Number(cloak.system.uses?.spent ?? 0) + 1, max);
    await cloak.update({
      "system.uses.spent": spent,
      [`system.activities.${cloakActivity.id}.name`]: DEFAULT_ECHO_NAME
    });
    await actor.unsetFlag(MODULE_ID, STATE_FLAG);

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<p><strong>Багряное эхо</strong>: ${spell.name} повторено без траты ячейки. Потрачен 1 заряд Багряной мантии.</p>`
    });
  } finally {
    REPLAYING.delete(actor.id);
  }
}

async function migrateCloak(item) {
  if (!isEchoItem(item)) return;
  const activity = getEchoActivity(item);
  if (!activity) return;

  const update = {};

  // Настройка не требуется.
  if (["required", "optional"].includes(item.system.attunement)) {
    update["system.attunement"] = "";
  }
  if (activity.visibility?.requireAttunement) {
    update[`system.activities.${activity.id}.visibility.requireAttunement`] = false;
  }

  // Переносим старый заряд действия в заряд самого предмета,
  // чтобы D&D 5e показывала его в колонке «Заряды» инвентаря.
  const oldSpent = Number(activity.uses?.spent ?? 0);
  const currentItemMax = Number(item.system.uses?.max ?? 0);
  if (currentItemMax !== 1) update["system.uses.max"] = "1";
  if (item.system.uses?.spent == null) update["system.uses.spent"] = Math.min(oldSpent, 1);

  const itemRecovery = item.system.uses?.recovery ?? [];
  const hasLongRestRecovery = itemRecovery.some(r => r.period === "lr" && r.type === "recoverAll");
  if (!hasLongRestRecovery) {
    update["system.uses.recovery"] = [
      { period: "lr", type: "recoverAll", formula: "" }
    ];
  }

  // Действие использует общий заряд предмета, а не собственный скрытый пул.
  const targets = activity.consumption?.targets ?? [];
  const hasItemUses = targets.some(t => t.type === "itemUses");
  if (!hasItemUses || targets.some(t => t.type === "activityUses")) {
    update[`system.activities.${activity.id}.consumption.targets`] = [
      {
        type: "itemUses",
        target: "",
        value: "1",
        scaling: { mode: "", formula: "" }
      }
    ];
  }

  // Старые uses действия больше не нужны.
  if (activity.uses?.max) {
    update[`system.activities.${activity.id}.uses.max`] = "";
    update[`system.activities.${activity.id}.uses.spent`] = 0;
    update[`system.activities.${activity.id}.uses.recovery`] = [];
  }

  if (Object.keys(update).length) {
    try {
      await item.update(update);
    } catch (err) {
      console.warn(`${MODULE_ID} | Не удалось автоматически обновить Багряную мантию`, err);
    }
  }
}

async function migrateAllCloaks() {
  if (!game.user?.isGM) return;

  const items = [
    ...(game.items?.contents ?? []),
    ...(game.actors?.contents ?? []).flatMap(actor => actor.items?.contents ?? [])
  ];

  for (const item of items) await migrateCloak(item);
}

Hooks.on("dnd5e.postUseActivity", (activity, usageConfig) => {
  void captureSpell(activity, usageConfig);
});

Hooks.on("dnd5e.preUseActivity", activity => {
  const isEchoActivity = activity?.flags?.[MODULE_ID]?.echoActivity === true
    || LEGACY_MODULE_IDS.some(id => activity?.flags?.[id]?.echoActivity === true);
  if (!isEchoActivity) return;
  void replayEcho(activity);
  return false;
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready`);
  void migrateAllCloaks();
});
