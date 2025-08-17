require('dotenv').config();

/**
 * Sofi/Nori autoclicker logic
 * Priority:
 * 1) Instantly grab any V card
 * 2) Else grab a card with hearts > 80
 * 3) Else grab the lowest g card
 * After picking the best card, click ALL Shell cards (if present).
 * If all three are Shell, click all of them.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const NORI_BOT_ID = process.env.NORI_BOT_ID;
const SOFI_BOT_ID = process.env.SOFI_BOT_ID;
const CHANNEL_ID = process.env.CHANNEL;

const WAIT_FILE = path.join(__dirname, 'wait.json');
let waitData = {};

if (fs.existsSync(WAIT_FILE)) {
  waitData = JSON.parse(fs.readFileSync(WAIT_FILE, 'utf-8'));
} else {
  fs.writeFileSync(WAIT_FILE, JSON.stringify({}));
}

const saveWaitData = () => {
  fs.writeFileSync(WAIT_FILE, JSON.stringify(waitData, null, 2));
};

const client = new Client({ checkUpdate: false });

let sessionId = null;
let lastSDMessage = null;
let lastButtonMessage = null;

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.username}`);
  sessionId = client.sessionId;
  console.log(`Session ID fetched: ${sessionId}`);

  setInterval(async () => {
    const now = Math.floor(Date.now() / 1000);
    const lastDrop = waitData[client.user.id] || 0;

    if (now - lastDrop >= 480) {
      const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
      if (!channel) return console.log(`[ERROR] Channel (${CHANNEL_ID}) not found!`);

      const delay = Math.floor(Math.random() * (5000 - 3000 + 1)) + 3000;
      setTimeout(() => {
        channel.send('sd').catch(console.error);
        console.log(`[AUTO DROP] Sent 'sd' in ${channel.id} after ${delay}ms`);
        waitData[client.user.id] = Math.floor(Date.now() / 1000);
        saveWaitData();
      }, delay);
    }
  }, 5000);
});

client.on('messageCreate', async (message) => {
  try {
    // Cache our own 'sd' message
    if (message.author.id === client.user.id && message.content && message.content.trim().toLowerCase() === 'sd') {
      lastSDMessage = message;
      lastButtonMessage = null;
      console.log('Cached SD message.');
      return;
    }

    // Cache Sofi button message tied to our last SD
    if (
      message.author.id === SOFI_BOT_ID &&
      message.guild &&
      message.reference &&
      lastSDMessage &&
      message.reference.messageId === lastSDMessage.id &&
      message.components?.length > 0
    ) {
      const allButtons = message.components.flatMap(row => row.components || []);
      const interactiveButtons = allButtons.filter(b => b && b.customId);

      if (interactiveButtons.length >= 1) {
        lastButtonMessage = message;
        console.log(`Cached Sofi button message (interactive buttons: ${interactiveButtons.length}).`);
      } else {
        console.log('[DEBUG] Sofi message has no interactive buttons (likely only links).');
      }

      return;
    }

    // Nori summary — parse and click
    if (
      message.author.id === NORI_BOT_ID &&
      message.guild &&
      message.reference &&
      lastSDMessage &&
      message.reference.messageId === lastSDMessage.id &&
      lastButtonMessage
    ) {
      const lines = message.content.split('\n').filter(line => line.includes(']'));
      const cards = [];

      for (const raw of lines) {
        const clean = raw.replace(/`/g, '').trim();

        const buttonMatch = clean.match(/(\d)\]/);
        const heartMatch = clean.match(/:heart:\s*(\d*)/); // allow empty
        const genMatch = clean.match(/([vɢ])\s*(\d*)/i);
        const nameMatch = clean.match(/\*\*(.*?)\*\*/);
        const animeMatch = (clean.split('•') || []).slice(-1)[0]?.trim();

        if (buttonMatch && genMatch) {
          const button = parseInt(buttonMatch[1]);
          const hearts = heartMatch ? parseInt(heartMatch[1] || '0') : 0;
          const genType = (genMatch[1] || '').toLowerCase();
          const gen = parseInt(genMatch[2] || '0');

          cards.push({
            button,
            hearts: isNaN(hearts) ? 0 : hearts,
            gen: isNaN(gen) ? 0 : gen,
            genType,
            cardName: (nameMatch?.[1] || 'Unknown').trim(),
            animeName: animeMatch || 'Unknown'
          });
        }
      }

      if (cards.length === 0) {
        console.log(`[DEBUG] No cards found in Nori summary: ${message.content}`);
        lastButtonMessage = null;
        lastSDMessage = null;
        return;
      }

      // Split Shell vs Non-Shell
      const shellCards = cards.filter(c => c.cardName.toLowerCase() === 'shell');
      const nonShellCards = cards.filter(c => c.cardName.toLowerCase() !== 'shell');

      let bestCard = null;

// 1) V-card instant priority
const vCards = nonShellCards.filter(c => c.genType === 'v');
if (vCards.length > 0) {
  // Sort by gen descending (optional, pick strongest V)
  bestCard = vCards.sort((a, b) => b.gen - a.gen || a.button - b.button)[0];
} else {
  // 2) Highest hearts > 80
  const highHeartCards = nonShellCards.filter(c => c.hearts > 100);
  if (highHeartCards.length > 0) {
    bestCard = highHeartCards.sort((a, b) => (b.hearts - a.hearts) || (a.gen - b.gen) || (a.button - b.button))[0];
  } else if (nonShellCards.length > 0) {
    // 3) Lowest g
    bestCard = nonShellCards.sort((a, b) => (a.gen - b.gen) || (a.button - b.button))[0];
  }
}

      if (!bestCard && shellCards.length > 0) {
        console.log('[INFO] Only Shell cards found, will click all of them.');
      }

      const allButtons = lastButtonMessage.components.flatMap(row => row.components || []);
      const interactiveButtons = allButtons.filter(b => b && b.customId);

      const clickShells = async () => {
        for (let i = 0; i < shellCards.length; i++) {
          const sc = shellCards[i];
          const scBtn = interactiveButtons[sc.button - 1];
          if (scBtn) {
            const scDelay = 2000 + Math.floor(Math.random() * 1000);
            console.log(`Waiting ${scDelay}ms before clicking Shell card #${i + 1}`);
            await new Promise(res => setTimeout(res, scDelay));
            await clickButtonFromComponent(lastButtonMessage, scBtn);
            console.log(`Clicked Shell card #${i + 1}`);
          }
        }
      };

      // Faster reaction for V-cards, otherwise normal small delay
      const randomDelay = (bestCard && bestCard.genType === 'v')
        ? Math.floor(Math.random() * (300 - 100 + 1)) + 100
        : Math.floor(Math.random() * (800 - 300 + 1)) + 300;

      setTimeout(async () => {
        // Click best card if exists
        if (bestCard) {
          const bestBtn = interactiveButtons[bestCard.button - 1];
          if (bestBtn) {
            await clickButtonFromComponent(lastButtonMessage, bestBtn);
            console.log(`Clicked best card: ${bestCard.cardName} (hearts=${bestCard.hearts}, g=${bestCard.gen}, type=${bestCard.genType})`);
          } else {
            console.log('[WARN] Best card button not found in interactiveButtons.');
          }
        }

        // After best card (or if only shells), click every Shell
        if (shellCards.length > 0) await clickShells();

        lastButtonMessage = null;
        lastSDMessage = null;
      }, randomDelay);
    }
  } catch (err) {
    console.error('[UNEXPECTED]', err);
  }
});

async function clickButtonFromComponent(message, buttonComponent) {
  try {
    if (!buttonComponent || !buttonComponent.customId) {
      return console.log('Button component invalid or has no customId.');
    }

    const nonce = Date.now().toString();
    const payload = {
      type: 3,
      nonce,
      session_id: sessionId,
      guild_id: message.guildId,
      channel_id: message.channelId,
      message_id: message.id,
      application_id: message.author.id,
      data: {
        component_type: 2,
        custom_id: buttonComponent.customId
      }
    };

    await axios.post('https://discord.com/api/v9/interactions', payload, {
      headers: {
        Authorization: TOKEN,
        'Content-Type': 'application/json'
      }
    });

    console.log(`Clicked button (customId: ${buttonComponent.customId})`);
  } catch (err) {
    console.error('Failed to click button:', err.response ? err.response.data : err.message);
  }
}

client.login(TOKEN);
