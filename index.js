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
        const heartMatch = cleanLine.match(/:heart:\s*(\d*)/); // allow empty hearts
        const genMatch = cleanLine.match(/([vɢ])\s*(\d*)/i);   // allow empty gen
        const nameMatch = cleanLine.match(/\*\*(.*?)\*\*/);
        const animeMatch = (cleanLine.split('•') || []).slice(-1)[0]?.trim();

        if (buttonMatch && nameMatch) {
          const button = parseInt(buttonMatch[1]);
          const hearts = heartMatch && heartMatch[1] ? parseInt(heartMatch[1]) : 0;
          const genType = genMatch ? genMatch[1] : '?';
          const gen = genMatch && genMatch[2] ? parseInt(genMatch[2]) : 9999;

          cards.push({
            button,
            hearts,
            gen,
            genType,
            cardName: nameMatch[1],
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

      // Separate Shell cards and normal cards
      const shellCards = cards.filter(c => c.cardName.toLowerCase() === 'shell');
      const nonShellCards = cards.filter(c => c.cardName.toLowerCase() !== 'shell');

      let bestCard = null;

      if (nonShellCards.length > 0) {
        // Select best card only from non-Shell cards
        const vCards = nonShellCards.filter(c => c.genType.toLowerCase() === 'v');

        if (vCards.length > 0) {
          bestCard = vCards[0];
        } else {
          const otherPriorityCards = nonShellCards.filter(c => c.gen < 50 || c.hearts > 200);

          if (otherPriorityCards.length > 0) {
            bestCard = otherPriorityCards.sort((a, b) => {
              if (b.hearts !== a.hearts) return b.hearts - a.hearts;
              return a.gen - b.gen;
            })[0];
          } else {
            const highHeartCards = nonShellCards.filter(c => c.hearts > 70);
            if (highHeartCards.length > 0) {
              bestCard = highHeartCards.sort((a, b) => {
                if (b.hearts !== a.hearts) return b.hearts - a.hearts;
                return a.gen - b.gen;
              })[0];
            } else {
              bestCard = nonShellCards.sort((a, b) => {
                if (a.gen !== b.gen) return a.gen - b.gen;
                return a.button - b.button;
              })[0];
            }
          }
        }
      }

      if (!bestCard && shellCards.length === 0) {
        console.log('[WARN] No best card or Shell cards found. Skipping.');
        lastButtonMessage = null;
        lastSDMessage = null;
        return;
      }

      const allButtons = lastButtonMessage.components.flatMap(row => row.components || []);
      const interactiveButtons = allButtons.filter(b => b && b.customId);

      // Click best card first if available
      const doClicks = async () => {
        if (bestCard) {
          console.log(`Selected -> Button: ${bestCard.button}, Hearts: ${bestCard.hearts}, GenType: ${bestCard.genType}${bestCard.gen}`);
          const targetIndex = Math.max(0, bestCard.button - 1);
          let chosenButton = interactiveButtons[targetIndex] || interactiveButtons[0];
          await clickButtonFromComponent(lastButtonMessage, chosenButton);
          console.log(`Clicked best card button: ${bestCard.cardName}`);
        }

        // Always click ALL Shell cards
        if (shellCards.length > 0) {
          console.log(`Found ${shellCards.length} Shell card(s), will click all with delays.`);

          for (let i = 0; i < shellCards.length; i++) {
            const shellCard = shellCards[i];
            const shellButtonIndex = Math.max(0, shellCard.button - 1);
            const shellButton = interactiveButtons[shellButtonIndex];

            if (shellButton) {
              const shellDelay = 1500 + Math.floor(Math.random() * 1000); // 1.5–2.5s delay
              console.log(`Waiting ${shellDelay}ms before clicking Shell card button #${i + 1}`);

              await new Promise(res => setTimeout(res, shellDelay));
              await clickButtonFromComponent(lastButtonMessage, shellButton);
              console.log(`Clicked Shell card button #${i + 1}`);
            } else {
              console.log(`[WARN] Shell card button not found for Shell card #${i + 1}`);
            }
          }
        }

        lastButtonMessage = null;
        lastSDMessage = null;
      };

      const randomDelay = Math.floor(Math.random() * (800 - 300 + 1)) + 300;
      setTimeout(doClicks, randomDelay);
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
