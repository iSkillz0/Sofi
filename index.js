require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('discord.js-selfbot-v13');

const STATE_FILE = path.resolve(__dirname, 'bot-state.json');
const COOLDOWN_BASE = 8 * 60 * 1000; // 8 minutes
const COOLDOWN_RANDOM_EXTRA = 5000; // up to 5 seconds extra
const MIN_CARD_DELAY = 2000; // 2 seconds
const MAX_CARD_DELAY = 5000; // 5 seconds

const config = {
  token: process.env.DISCORD_TOKEN,
  channelId: process.env.CHANNEL_ID,
};
const SOFI_BOT_ID = process.env.SOFI_BOT_ID;

let scheduledSdTimer = null;
let state = {
  lastSdTime: null,
  pendingResponse: false,
  lastAction: null,
  lastSelectedIndex: null,
  history: [],
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      state = Object.assign(state, parsed);
      console.log('📥 Loaded saved bot state:', {
        lastSdTime: state.lastSdTime,
        pendingResponse: state.pendingResponse,
        lastAction: state.lastAction,
      });
    }
  } catch (error) {
    console.error('❌ Failed to load state file:', error);
  }
}

function saveState(sync = false) {
  try {
    const payload = JSON.stringify(state, null, 2);
    if (sync) {
      fs.writeFileSync(STATE_FILE, payload, 'utf8');
    } else {
      fs.writeFile(STATE_FILE, payload, 'utf8', (error) => {
        if (error) console.error('❌ Failed to save state file:', error);
      });
    }
  } catch (error) {
    console.error('❌ Failed to save state:', error);
  }
}

function appendHistory(entry) {
  state.history.push(entry);
  if (state.history.length > 100) {
    state.history.splice(0, state.history.length - 100);
  }
  saveState();
}

function validateConfig() {
  const missing = [];
  if (!config.token) missing.push('DISCORD_TOKEN');
  if (!config.channelId) missing.push('CHANNEL_ID');
  if (!SOFI_BOT_ID) missing.push('SOFI_BOT_ID');

  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('⚙️ Config loaded:', {
    channelId: config.channelId,
    hasToken: !!config.token,
    hasSofiBotId: !!SOFI_BOT_ID,
    cooldownMinutes: 8,
  });
}

function getCooldownDuration() {
  return COOLDOWN_BASE + Math.floor(Math.random() * (COOLDOWN_RANDOM_EXTRA + 1));
}

function getNextSdDelay() {
  if (!state.lastSdTime) return 0;
  const elapsed = Date.now() - state.lastSdTime;
  const target = getCooldownDuration();
  return elapsed >= target ? 0 : target - elapsed;
}

function scheduleNextSd() {
  if (scheduledSdTimer) {
    clearTimeout(scheduledSdTimer);
  }

  let delay = getNextSdDelay();
  if (state.pendingResponse && delay === 0) {
    delay = 5000;
  }

  scheduledSdTimer = setTimeout(sendSdCommand, delay);
  console.log(`⏱️ Next sd scheduled in ${Math.ceil(delay / 1000)} seconds`);
}

async function sendSdCommand() {
  if (state.pendingResponse) {
    console.log('⏳ Pending response still open; delaying next sd until response completes.');
    scheduleNextSd();
    return;
  }

  try {
    const channel = await client.channels.fetch(config.channelId);
    if (!channel) {
      throw new Error('Channel not found. Please check your CHANNEL_ID.');
    }

    console.log('📤 Sending "sd" command...');
    await channel.send('sd');

    state.lastSdTime = Date.now();
    state.pendingResponse = true;
    state.lastAction = 'sent_sd';
    appendHistory({
      event: 'sent_sd',
      time: new Date().toISOString(),
      channelId: config.channelId,
    });
    saveState();
  } catch (error) {
    console.error('❌ Error sending sd command:', error);
    appendHistory({
      event: 'sd_error',
      time: new Date().toISOString(),
      error: String(error),
    });
  }

  scheduleNextSd();
}

function randomDelay() {
  return MIN_CARD_DELAY + Math.floor(Math.random() * (MAX_CARD_DELAY - MIN_CARD_DELAY + 1));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const client = new Client();

client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.username}`);
  console.log('🎴 Sofi card automation is active.');
  scheduleNextSd();
});

client.on('messageCreate', async (message) => {
  if (message.channelId !== config.channelId || message.author.id !== SOFI_BOT_ID) {
    return;
  }

  if (!state.pendingResponse) {
    console.log('ℹ️ Received a Sofi bot message outside of a pending sd response; ignoring.');
    return;
  }

  const waitMs = randomDelay();
  console.log(`⏳ Waiting ${waitMs}ms before selecting the best card...`);
  await delay(waitMs);

  if (!message.components || message.components.length === 0) {
    console.log('⚠️ Received Sofi message with no buttons; marking response as complete.');
    state.pendingResponse = false;
    state.lastAction = 'no_buttons';
    appendHistory({ event: 'no_buttons', time: new Date().toISOString() });
    saveState();
    return;
  }

  const cardData = parseCardData(message);
  if (!cardData || cardData.length === 0) {
    console.log('⚠️ No card data parsed; marking response as complete.');
    state.pendingResponse = false;
    state.lastAction = 'parse_failed';
    appendHistory({ event: 'parse_failed', time: new Date().toISOString() });
    saveState();
    return;
  }

  const selectedCard = selectBestCard(cardData);
  if (selectedCard === null) {
    console.log('⚠️ No suitable card selected; marking response as complete.');
    state.pendingResponse = false;
    state.lastAction = 'no_suitable_card';
    appendHistory({ event: 'no_suitable_card', time: new Date().toISOString(), cardData });
    saveState();
    return;
  }

  const buttons = message.components.flatMap((row) => row.components || []);
  const button = buttons[selectedCard];
  let buttonClicked = false;

  if (button) {
    try {
      if (button.customId && typeof message.clickButton === 'function') {
        await message.clickButton(button.customId);
      } else if (button.customId && client.api && client.api.interactions) {
        await client.api.interactions.post({
          data: {
            type: 3,
            data: {
              custom_id: button.customId,
              component_type: button.type || 2,
            },
          },
        });
      } else if (typeof message.clickButton === 'function') {
        await message.clickButton(button);
      } else if (typeof button.click === 'function') {
        await button.click();
      } else {
        throw new Error('No supported click method available');
      }

      console.log('✅ Button clicked!');
      buttonClicked = true;
      state.pendingResponse = false;
      state.lastAction = 'button_clicked';
      state.lastSelectedIndex = selectedCard;
      appendHistory({
        event: 'button_clicked',
        time: new Date().toISOString(),
        selectedIndex: selectedCard,
        card: cardData[selectedCard],
      });
      saveState();
    } catch (error) {
      console.error('❌ Click failed:', error);
      appendHistory({ event: 'click_failed', time: new Date().toISOString(), error: String(error), selectedIndex: selectedCard });
      state.pendingResponse = false;
      state.lastAction = 'click_failed';
      saveState();
    }
  }

  if (!buttonClicked) {
    console.error('❌ Could not click button.');
    state.pendingResponse = false;
    state.lastAction = 'button_missing';
    appendHistory({ event: 'button_missing', time: new Date().toISOString(), selectedIndex: selectedCard });
    saveState();
  }
});

client.on('error', (error) => {
  console.error('❌ Client error:', error);
  appendHistory({ event: 'client_error', time: new Date().toISOString(), error: String(error) });
  saveState(true);
});

function parseHeartValue(label) {
  if (!label) return null;
  const normalized = label.replace(/,/g, '').trim().toLowerCase();
  const match = normalized.match(/^([\d.]+)\s*([km])?$/i);
  if (!match) return null;

  let value = parseFloat(match[1]);
  if (Number.isNaN(value)) return null;

  const suffix = match[2] ? match[2].toLowerCase() : null;
  if (suffix === 'k') {
    value *= 1000;
  } else if (suffix === 'm') {
    value *= 1000000;
  }

  return Math.round(value);
}

function parseCardData(message) {
  const cards = [];

  try {
    const rawText = message.content || (message.embeds && message.embeds.map((e) => e.description || '').join('\n')) || '';
    const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
    let cardLines = lines.filter((line) => /^\s*(?:`)?\s*\d+\./.test(line));

    if (cardLines.length === 0) {
      cardLines = lines.filter((line) => /gen\s*[:=]?\s*\d+/i.test(line) && /heart\s*[:=]?\s*([\d,.]+\s*[km]?)/i.test(line)).slice(0, 3);
    }

    const buttons = message.components.flatMap((row) => row.components || []);

    for (let i = 0; i < Math.min(cardLines.length, buttons.length, 3); i++) {
      const line = cardLines[i];
      const cardInfo = {
        gen: null,
        heart: null,
        index: i,
      };

      const genMatch = line.match(/G•\s*`?(\d+)`?/i) || line.match(/gen\s*[:=]?\s*(\d+)/i);
      if (genMatch) {
        cardInfo.gen = parseInt(genMatch[1], 10);
      }

      const button = buttons[i];
      if (button && button.label) {
        let heartLabel = null;
        let heartMatch = button.label.match(/❤️\s*([\d.,]+\s*[km]?)/i);
        if (!heartMatch) {
          heartMatch = button.label.match(/heart\s*[:=]?\s*([\d.,]+\s*[km]?)/i);
        }
        if (!heartMatch) {
          heartMatch = button.label.match(/([\d.,]+\s*[km]?)\s*❤️/i);
        }
        if (!heartMatch) {
          heartMatch = button.label.match(/^\s*([\d.,]+\s*[km]?)\s*$/i);
        }
        if (heartMatch) {
          heartLabel = heartMatch[1];
        }

        if (heartLabel) {
          cardInfo.heart = parseHeartValue(heartLabel);
        }
      }

      if (cardInfo.gen !== null && cardInfo.heart !== null) {
        cards.push(cardInfo);
      }
    }
  } catch (error) {
    console.error('❌ Error parsing card data:', error);
    appendHistory({ event: 'parse_error', time: new Date().toISOString(), error: String(error) });
  }

  return cards;
}

function selectBestCard(cardData) {
  if (cardData.length === 0) return null;

  const highHeartCards = cardData.filter((card) => card.heart !== null && card.heart >= 100);
  if (highHeartCards.length > 0) {
    let bestCard = highHeartCards[0];
    for (const card of highHeartCards) {
      if (card.heart > bestCard.heart) {
        bestCard = card;
      }
    }
    return bestCard.index;
  }

  let lowestGenCard = cardData[0];
  for (const card of cardData) {
    if (card.gen !== null && (lowestGenCard.gen === null || card.gen < lowestGenCard.gen)) {
      lowestGenCard = card;
    }
  }

  return lowestGenCard.index;
}

function saveAndExit(error) {
  if (error) {
    console.error('❌ Fatal error:', error);
    appendHistory({ event: 'fatal_error', time: new Date().toISOString(), error: String(error) });
  }
  saveState(true);
  process.exit(1);
}

process.on('unhandledRejection', (reason) => saveAndExit(reason));
process.on('uncaughtException', (error) => saveAndExit(error));
process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, saving state and exiting.');
  saveState(true);
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, saving state and exiting.');
  saveState(true);
  process.exit(0);
});

loadState();
validateConfig();

client.login(config.token)
  .then(() => {
    console.log('🔐 Discord login started. Waiting for ready event...');
  })
  .catch((loginError) => {
    console.error('❌ Discord login failed:', loginError);
    saveAndExit(loginError);
  });

