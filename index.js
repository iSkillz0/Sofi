require('dotenv').config();
const http = require('http');
const { Client } = require('discord.js-selfbot-v13');
const port = process.env.PORT || 4000;
const client = new Client();

// Configuration from environment variables
const config = {
  token: process.env.DISCORD_TOKEN,
  channelId: process.env.CHANNEL_ID,
};

const SOFI_BOT_ID = process.env.SOFI_BOT_ID;

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
    port,
  });
}

validateConfig();

// Small HTTP server required by Render for port binding
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Sofi card bot is running');
});

server.listen(port, () => {
  console.log(`🌐 Render port bound on ${port}`);
});

server.on('error', (err) => {
  console.error('❌ HTTP server error:', err);
});

const SOFI_BOT_ID = process.env.SOFI_BOT_ID;
const COOLDOWN_TIME = 8 * 60 * 1000; // 8 minutes in milliseconds
let lastCardPickTime = 0;
let isWaitingForResponse = false;

client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.username}`);
  console.log('🎴 Starting the Sofi card automation...');

  if (!config.token || !config.channelId || !SOFI_BOT_ID) {
    console.error('❌ Missing environment configuration. Set DISCORD_TOKEN, CHANNEL_ID, and SOFI_BOT_ID.');
    process.exit(1);
  }

  // Start fixed-interval 'sd' command, regardless of click results
  startSdLoop();
});

function startSdLoop() {
  // Immediate first call
  sendSdCommand();

  // Then run every COOLDOWN_TIME
  setInterval(() => {
    sendSdCommand();
  }, COOLDOWN_TIME);
}

async function sendSdCommand() {
  try {
    const channel = await client.channels.fetch(config.channelId);

    if (!channel) {
      console.error('❌ Channel not found. Please check your CHANNEL_ID in config.');
      return;
    }

    console.log('📤 Sending "sd" command...');
    await channel.send('sd');
    isWaitingForResponse = true;
  } catch (error) {
    console.error('❌ Error sending sd command:', error);
  }
}

client.on('messageCreate', async (message) => {
  // Only process messages in the target channel from Sofi bot
  if (message.channelId !== config.channelId || message.author.id !== SOFI_BOT_ID) return;

  // Skip messages with no components (buttons)
  if (!message.components || message.components.length === 0) {
    console.log('⚠️ Received Sofi message with no buttons, waiting for next schedule.');
    isWaitingForResponse = false;
    return;
  }

  const cardData = parseCardData(message);
  if (!cardData || cardData.length === 0) {
    console.log('⚠️ No card data parsed, waiting for next schedule.');
    isWaitingForResponse = false;
    return;
  }

  const selectedCard = selectBestCard(cardData);
  if (selectedCard === null) {
    console.log('⚠️ No suitable card selected, waiting for next schedule.');
    isWaitingForResponse = false;
    return;
  }

  const card = cardData[selectedCard];

  let buttonClicked = false;
  for (let rowIdx = 0; rowIdx < message.components.length && !buttonClicked; rowIdx++) {
    const row = message.components[rowIdx];
    if (row.components && row.components[selectedCard]) {
      const button = row.components[selectedCard];

      try {
        // click by customId first (preferred for most interactions)
        if (button.customId && typeof message.clickButton === 'function') {
          await message.clickButton(button.customId);
        } else if (button.customId && client.api && client.api.interactions) {
          await client.api.interactions.post({
            data: {
              type: 3,
              data: {
                custom_id: button.customId,
                component_type: button.type || 2
              }
            }
          });
        } else if (typeof message.clickButton === 'function') {
          await message.clickButton(button);
        } else if (typeof button.click === 'function') {
          await button.click();
        } else {
          throw new Error('No supported click method available');
        }

        console.log(`✅ Button clicked!`);
        isWaitingForResponse = false;
        buttonClicked = true;
      } catch (err) {
        console.error(`❌ Click failed: ${err.message}`);
        // fallback to direct button click by customId if initial path did not use it
        if (button.customId && typeof message.clickButton === 'function') {
          try {
            await message.clickButton(button.customId);
            console.log(`✅ Button clicked with fallback!`);
            isWaitingForResponse = false;
            buttonClicked = true;
          } catch (err2) {
            console.error(`❌ Fallback also failed: ${err2.message}`);
            isWaitingForResponse = false;
          }
        } else {
          isWaitingForResponse = false;
        }
      }
    }
  }

  if (!buttonClicked) {
    console.error('❌ Could not click button');
    isWaitingForResponse = false;
  }
});

client.on('error', (error) => {
  console.error('❌ Client error:', error);
});

function parseCardData(message) {
  const cards = [];
  
  try {
    // Split message content into lines and parse each card line
    const rawText = message.content || (message.embeds && message.embeds.map(e => e.description || '').join('\n')) || '';
    const lines = rawText.split('\n').filter(line => line.trim());
    
    // Filter for card lines that start with numbered format (1., 2., 3.) or with backticks like `1.`
    const cardLines = lines.filter(line => /^\s*(?:`)?\s*\d+\./.test(line));

    if (cardLines.length === 0) {
      // Fallback: maybe the card line is not numbered and only contains 'Gen' and 'Heart'
      const fallbackCardLines = lines.filter(line => /gen\s*[:=]?\s*\d+/i.test(line) && /heart\s*[:=]?\s*\d+/i.test(line));
      if (fallbackCardLines.length > 0) {
        fallbackCardLines.slice(0, 3).forEach(l => cardLines.push(l));
      }
    }
    
    // Parse each card from the filtered card lines
    for (let i = 0; i < Math.min(3, cardLines.length); i++) {
      const line = cardLines[i].trim();
      
      const cardInfo = {
        gen: null,
        heart: null,
        index: i
      };
      
      // Extract Gen from this specific line
      const genMatch = line.match(/G•\s*`?(\d+)`?/i);
      if (genMatch) {
        cardInfo.gen = parseInt(genMatch[1]);
      }
      
      // Parse corresponding button for heart values
      let buttonFound = false;
      for (let rowIdx = 0; rowIdx < message.components.length && !buttonFound; rowIdx++) {
        const row = message.components[rowIdx];
        if (row.components && row.components[i]) {
          const button = row.components[i];
          
          if (button.label) {
            // Try different heart patterns
            let heartMatch = button.label.match(/❤️\s*(\d+)/);
            if (!heartMatch) {
              heartMatch = button.label.match(/heart[:\s]*(\d+)/i);
            }
            if (!heartMatch) {
              heartMatch = button.label.match(/(\d+)\s*❤️/);
            }
            if (!heartMatch) {
              // If no heart emoji found, use the number as heart value
              heartMatch = button.label.match(/(\d+)/);
            }
            
            if (heartMatch) {
              cardInfo.heart = parseInt(heartMatch[1]);
              buttonFound = true;
            }
          }
        }
      }
      
      if (cardInfo.gen !== null && cardInfo.heart !== null) {
        cards.push(cardInfo);
      }
    }
  } catch (error) {
    console.error('❌ Error parsing card data:', error);
  }
  
  return cards;
}

function selectBestCard(cardData) {
  if (cardData.length === 0) return null;
  
  // Check if any card has heart >= 100
  const highHeartCards = cardData.filter(card => card.heart >= 100);
  
  if (highHeartCards.length > 0) {
    // Pick the card with highest heart among those with heart >= 100
    let bestCard = highHeartCards[0];
    for (let card of highHeartCards) {
      if (card.heart > bestCard.heart) {
        bestCard = card;
      }
    }
    return bestCard.index;
  }
  
  // Otherwise, pick the card with the lowest gen
  let lowestGenCard = cardData[0];
  for (let card of cardData) {
    if (card.gen < lowestGenCard.gen) {
      lowestGenCard = card;
    }
  }
  
  return lowestGenCard.index;
}

client.login(config.token)
  .then(() => {
    console.log('🔐 Discord login started. Waiting for ready event...');
  })
  .catch((loginError) => {
    console.error('❌ Discord login failed:', loginError);
    process.exit(1);
  });

