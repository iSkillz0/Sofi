require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const port = process.env.PORT || 4000 
const client = new Client();

// Configuration from environment variables
const config = {
  token: process.env.DISCORD_TOKEN,
  channelId: process.env.CHANNEL_ID,
};

const SOFI_BOT_ID = process.env.SOFI_BOT_ID;
const COOLDOWN_TIME = 8 * 60 * 1000; // 8 minutes in milliseconds
let lastCardPickTime = 0;
let isWaitingForResponse = false;

client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.username}`);
  console.log('🎴 Starting the Sofi card automation...');
  
  // Send initial 'sd' command
  sendSdCommand();
});

async function sendSdCommand() {
  // Prevent double sends
  if (isWaitingForResponse) {
    console.log('⚠️ Already waiting for response, skipping sd send');
    return;
  }
  
  try {
    const channel = await client.channels.fetch(config.channelId);
    
    if (!channel) {
      console.error('❌ Channel not found. Please check your CHANNEL_ID in config.');
      return;
    }
    
    console.log('\n📤 Sending "sd" command...');
    await channel.send('sd');
    isWaitingForResponse = true;
    console.log('⏳ Waiting for Sofi bot response...');
  } catch (error) {
    console.error('❌ Error sending sd command:', error);
  }
}

client.on('messageCreate', async (message) => {
  // Only process messages in the target channel
  if (message.channelId !== config.channelId) return;
  
  // Log ALL messages for debugging
  console.log(`\n📨 [${message.author.username}] ID: ${message.author.id}`);
  console.log(`   Embeds: ${message.embeds.length}, Components: ${message.components.length}`);
  if (message.content) console.log(`   Content: ${message.content}`);
  
  // Only process if waiting AND from Sofi bot
  if (!isWaitingForResponse || message.author.id !== SOFI_BOT_ID) return;
  
  // Skip messages with no components (buttons)
  if (!message.components || message.components.length === 0) {
    console.log('   ⚠️ Skipping - no buttons');
    return;
  }
  
  try {
    console.log('   🎴 Processing card message with buttons...');
    const cardData = parseCardData(message);
    
    if (cardData && cardData.length > 0) {
      const selectedCard = selectBestCard(cardData);
      
      if (selectedCard !== null) {
        const card = cardData[selectedCard];
        console.log(`✅ Selected: Card ${selectedCard + 1} (Gen ${card.gen}, Heart ${card.heart})`);
        
        if (message.components && message.components.length > 0) {
          let buttonClicked = false;
          
          for (let rowIdx = 0; rowIdx < message.components.length && !buttonClicked; rowIdx++) {
            const row = message.components[rowIdx];
            if (row.components && row.components[selectedCard]) {
              const button = row.components[selectedCard];
              console.log(`🖱️ Attempting to click button:`, {
                label: button.label,
                customId: button.customId,
                style: button.style,
                type: button.type
              });
              
              try {
                await message.clickButton(button);
                console.log(`✅ Button clicked!`);
                isWaitingForResponse = false;
                setTimeout(sendSdCommand, COOLDOWN_TIME);
                buttonClicked = true;
              } catch (err) {
                console.error(`❌ Click failed: ${err.message}`);
                // Try alternative method if available
                if (button.customId) {
                  try {
                    console.log(`🔄 Trying with customId: ${button.customId}`);
                    await message.clickButton(button.customId);
                    console.log(`✅ Button clicked with customId!`);
                    isWaitingForResponse = false;
                    setTimeout(sendSdCommand, COOLDOWN_TIME);
                    buttonClicked = true;
                  } catch (err2) {
                    console.error(`❌ Click with customId also failed: ${err2.message}`);
                  }
                }
              }
            }
          }
          
          if (!buttonClicked) console.error('❌ Could not click button');
        }
      }
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
});

client.on('error', (error) => {
  console.error('❌ Client error:', error);
});

function parseCardData(message) {
  const cards = [];
  
  try {
    console.log(`📋 Total components: ${message.components.length}`);
    
    // Split message content into lines and parse each card line
    const lines = message.content.split('\n').filter(line => line.trim());
    console.log(`📝 Found ${lines.length} lines in message`);
    
    // Filter for card lines that start with numbered format (1., 2., 3.)
    const cardLines = lines.filter(line => /^\s*`\d+\.`/.test(line));
    console.log(`🎴 Found ${cardLines.length} card lines`);
    
    // Parse each card from the filtered card lines
    for (let i = 0; i < Math.min(3, cardLines.length); i++) {
      const line = cardLines[i].trim();
      console.log(`\n🎴 Processing card ${i + 1}: ${line}`);
      
      const cardInfo = {
        gen: null,
        heart: null,
        index: i
      };
      
      // Extract Gen from this specific line
      const genMatch = line.match(/G•`(\d+)\s*`/);
      if (genMatch) {
        cardInfo.gen = parseInt(genMatch[1]);
        console.log(`   ✓ Gen found: ${cardInfo.gen}`);
      }
      
      // Parse corresponding button for heart values
      let buttonFound = false;
      for (let rowIdx = 0; rowIdx < message.components.length && !buttonFound; rowIdx++) {
        const row = message.components[rowIdx];
        if (row.components && row.components[i]) {
          const button = row.components[i];
          console.log(`   Button ${i} label: "${button.label}"`);
          console.log(`   Button ${i} emoji: ${button.emoji}`);
          
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
              console.log(`   ⚠️ Using raw number as heart: ${button.label}`);
            }
            
            if (heartMatch) {
              cardInfo.heart = parseInt(heartMatch[1]);
              console.log(`   ✓ Heart found: ${cardInfo.heart}`);
              buttonFound = true;
            }
          }
        }
      }
      
      if (cardInfo.gen !== null && cardInfo.heart !== null) {
        cards.push(cardInfo);
        console.log(`   ✅ Card ${i + 1} complete: Gen ${cardInfo.gen}, Heart ${cardInfo.heart}`);
      } else {
        console.log(`   ❌ Card ${i + 1} incomplete: Gen ${cardInfo.gen}, Heart ${cardInfo.heart}`);
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

client.login(config.token);
