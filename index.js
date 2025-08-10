require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const NORI_BOT_ID = process.env.NORI_BOT_ID;
const SOFI_BOT_ID = process.env.SOFI_BOT_ID;
const CHANNEL_ID = process.env.CHANNEL;
const WEBHOOK_URL = process.env.WEBHOOK;

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

    // Cache Sofi button message by position (ignore labels/emojis/links)
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

    // Nori summary — parse cards and decide which position to click
    if (
      message.author.id === NORI_BOT_ID &&
      message.guild &&
      message.reference &&
      lastSDMessage &&
      message.reference.messageId === lastSDMessage.id &&
      lastButtonMessage
    ) {
      const lines = message.content.split('\n').filter(line => line.includes(':heart:'));
      let cards = [];

      for (const line of lines) {
        const cleanLine = line.replace(/`/g, '').trim();

        const buttonMatch = cleanLine.match(/(\d)\]/);
        const heartMatch = cleanLine.match(/:heart:\s*(\d+)/);
        const genMatch = cleanLine.match(/([vɢ])\s*(\d+)/i);
        const nameMatch = cleanLine.match(/\*\*(.*?)\*\*/);
        const animeMatch = (cleanLine.split('•') || []).slice(-1)[0]?.trim();

        if (buttonMatch && heartMatch && genMatch) {
          const button = parseInt(buttonMatch[1]);
          const hearts = parseInt(heartMatch[1]);
          const genType = genMatch[1];
          const gen = parseInt(genMatch[2]);

          cards.push({ button, hearts, gen, genType, cardName: nameMatch?.[1] || 'Unknown', animeName: animeMatch || 'Unknown' });
        }
      }

      if (cards.length === 0) {
        console.log(`[DEBUG] No cards found in Nori summary: ${message.content}`);
        lastButtonMessage = null;
        lastSDMessage = null;
        return;
      }

      // Separate AO cards for clicking later
      const aoCards = cards.filter(c => c.cardName.toLowerCase() === 'ao');

      // Filter out AO cards for best card selection
      const nonAoCards = cards.filter(c => c.cardName.toLowerCase() !== 'ao');

      let bestCard;

      // Select best card only from non-AO cards:
      const vCards = nonAoCards.filter(c => c.genType.toLowerCase() === 'v');

      if (vCards.length > 0) {
        bestCard = vCards[0];
      } else {
        const otherPriorityCards = nonAoCards.filter(c => c.gen < 50 || c.hearts > 200);

        if (otherPriorityCards.length > 0) {
          bestCard = otherPriorityCards.sort((a, b) => {
            if (b.hearts !== a.hearts) return b.hearts - a.hearts;
            return a.gen - b.gen;
          })[0];
        } else {
          const highHeartCards = nonAoCards.filter(c => c.hearts > 70);
          if (highHeartCards.length > 0) {
            bestCard = highHeartCards.sort((a, b) => {
              if (b.hearts !== a.hearts) return b.hearts - a.hearts;
              return a.gen - b.gen;
            })[0];
          } else {
            bestCard = nonAoCards.sort((a, b) => {
              if (a.gen !== b.gen) return a.gen - b.gen;
              return a.button - b.button;
            })[0];
          }
        }
      }

      if (!bestCard) {
        console.log('[WARN] No best card found (all cards may be AO?). Skipping.');
        lastButtonMessage = null;
        lastSDMessage = null;
        return;
      }

      console.log(`Selected -> Button: ${bestCard.button}, Hearts: ${bestCard.hearts}, GenType: ${bestCard.genType}${bestCard.gen}`);

      // Webhook logging including AO cards
      const shouldLog = (
        bestCard.genType.toLowerCase() === 'ɢ' && bestCard.gen < 100 && bestCard.hearts > 100
      ) || (
        bestCard.genType.toLowerCase() === 'v'
      ) || (
        bestCard.hearts > 200
      ) || (
        bestCard.cardName.toLowerCase() === 'ao'   // (rare now since AO excluded but kept for safety)
      );

      if (shouldLog && WEBHOOK_URL) {
        const content = `• ${client.user.username} • :heart: ${bestCard.hearts}   • ${bestCard.genType}${bestCard.gen}  • **${bestCard.cardName}** • ${bestCard.animeName} • [JUMP](https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id})`;
        axios.post(WEBHOOK_URL, { content }).then(() => {
          console.log('[WEBHOOK] Logged best card:', content);
        }).catch(err => {
          console.error('[WEBHOOK ERROR]', err.response?.data || err.message);
        });
      }

      const allButtons = lastButtonMessage.components.flatMap(row => row.components || []);
      const interactiveButtons = allButtons.filter(b => b && b.customId);

      // Click best card button first
      const targetIndex = Math.max(0, bestCard.button - 1);
      let chosenButton = interactiveButtons[targetIndex];

      if (!chosenButton) {
        console.log('[WARN] target button not found by index, falling back to first interactive button');
        chosenButton = interactiveButtons[0];
      }

      const randomDelay = Math.floor(Math.random() * (800 - 300 + 1)) + 300;

      setTimeout(async () => {
        await clickButtonFromComponent(lastButtonMessage, chosenButton);
        console.log(`Clicked best card button: ${bestCard.cardName}`);

        // Click all AO cards except if AO is already best card (excluded above)
        if (aoCards.length > 0) {
          console.log(`Found ${aoCards.length} AO card(s), will click all with delays.`);

          for (let i = 0; i < aoCards.length; i++) {
            const aoCard = aoCards[i];
            const aoButtonIndex = Math.max(0, aoCard.button - 1);
            const aoButton = interactiveButtons[aoButtonIndex];

            if (aoButton) {
              const aoDelay = 2000 + Math.floor(Math.random() * 1000); // 2-3 sec delay
              console.log(`Waiting ${aoDelay}ms before clicking AO card button (${aoCard.cardName}) #${i + 1}`);

              await new Promise(res => setTimeout(res, aoDelay));

              await clickButtonFromComponent(lastButtonMessage, aoButton);
              console.log(`Clicked AO card button #${i + 1}: ${aoCard.cardName}`);
            } else {
              console.log(`[WARN] AO card button not found for AO card #${i + 1}`);
            }
          }
        }

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
    if (!buttonComponent || !buttonComponent.customId) return console.log('Button component invalid or has no customId.');

    const nonce = Date.now().toString();
    const payload = {
      type: 3,
      nonce: nonce,
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
