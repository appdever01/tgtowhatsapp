const { fetch, transcribe, formatSeconds, geminiSummarize, displayIsraelTime } = require('./lib/utils')
const { readFile, writeFile } = require('./lib/handler')
const TelegramAPI = require('node-telegram-bot-api')
const {
    default: Baileys,
    delay,
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState
} = require('@whiskeysockets/baileys')
const { imageSync } = require('qr-image')
const { schedule } = require('node-cron')
const { readFileSync, remove } = require('fs-extra')
const { Boom } = require('@hapi/boom')
const app = require('express')()
const chalk = require('chalk')
const P = require('pino')

// configuration
const { prefix, port, mods, adminGroup, token, telegramGroup } = require('./getConfig')()

// telegram bot configuration
const bot = new TelegramAPI(token, { polling: true })

// custom summary prompt
const summaryPrompt = readFileSync('./src/prompts/summary.txt', 'utf8')

// required files
const groups = readFile('groups.json', [])
const summaries = readFile('summaries.json', [])
const store = readFile('store.json')
const words = readFile('words.json')
const messageStone = readFile('messages.json')

// load all channels
const getChannels = () => {
    groups.forEach((group) => (group.channels = group.channels.map((channel) => channel.toLowerCase())))
    writeFile('groups.json', groups)
}

// adding messages with unique id
const addMessage = (channel, content) => {
    ;(messageStone[channel] = messageStone[channel] || []).push(content)
    writeFile('messages.json', messageStone)
}

// saving unique words in words.json
const saveWords = async (content) => {
    words.keywords = words.keywords || []
    words.keywords = [...new Set([...words.keywords, ...(Array.isArray(content) ? content : [])])]
    writeFile('words.json', words)
}

// setting up category of words
const updateWords = (category, element) => {
    const index = isNaN(element) ? words.keywords.indexOf(element) : parseInt(element)
    if (isNaN(index) || index < 0 || index >= words.keywords.length) return 'Not Found'
    const removed = words.keywords.splice(index, 1)[0]
    words.roles = words.roles || []
    let role =
        words.roles.find((r) => r[category]) ||
        (words.roles.push({ [category]: [] }), words.roles[words.roles.length - 1])
    role[category].push(removed)
    writeFile('words.json', words)
    return 'OK'
}

// starting whatsapp bot
const start = async () => {
    const { state, saveCreds } = await useMultiFileAuthState('session')
    const client = Baileys({
        version: (await fetchLatestBaileysVersion()).version,
        printQRInTerminal: true,
        auth: state,
        logger: P({ level: 'fatal' }),
        browser: ['TG-WhatsApp', 'fatal', '1.0.0']
    })

    client.log = (text, error = false) =>
        console.log(chalk[error ? 'red' : 'blue']('TG-WhatsApp'), chalk[error ? 'redBright' : 'greenBright'](text))

    client.ev.on('connection.update', async (update) => {
        if (update.qr) {
            client.log(`QR code generated. Scan it to continue | You can also authenticate in http://localhost:${port}`)
            client.QR = imageSync(update.qr)
        }
        const { connection, lastDisconnect } = update
        if (connection === 'close') {
            const { statusCode } = new Boom(lastDisconnect?.error).output
            if (statusCode !== DisconnectReason.loggedOut) {
                client.log('Reconnecting...')
                setTimeout(() => start(), 3000)
            } else {
                client.log('Disconnected.', true)
                await remove('session')
                client.log('Starting...')
                setTimeout(() => start(), 3000)
            }
        }
        if (connection === 'connecting') client.log('Connecting to WhatsApp...')
        if (connection === 'open') {
            client.log('Connected to WhatsApp')
            getChannels()
            if (!groups.length) client.log('No Groups or Channel Found', true)
            const ready = groups.every((group) => group.from)
            if (!ready) client.log('ID required type /id in group', true)
            else {
                client.log(`Total Channels: ${groups.reduce((sum, group) => sum + group.channels.length, 0)}`)

                for (const group of groups) {
                    for (const channel of group.channels) {
                        if (!store[channel]) {
                            const messages = await fetch(channel).catch(() => null)
                            if (messages && messages.length) {
                                store[channel] = messages[messages.length - 1].id
                            }
                        }
                    }
                }
                writeFile('store.json', store)

                const pollChannels = async () => {
                    for (const group of groups) {
                        await fetchChannels({ from: group.from, channels: group.channels })
                    }
                    setTimeout(pollChannels, 5000)
                }

                pollChannels()

                schedule('0 * * * *', summarizeChannels)
                schedule('0 0 * * *', () => writeFile('summaries.json', []))
            }
        }
    })

    client.ev.on('messages.upsert', async ({ messages }) => {
        const formatArgs = (args) => args.slice(1).join(' ').trim()
        const M = messages[0]
        M.from = M.key.remoteJid || ''
        M.sender = M.key.participant || ''
        M.content = M.message?.conversation || ''
        M.reply = (text) => client.sendMessage(M.from, { text }, { quoted: M })
        const args = M.content.split(' ')
        const context = formatArgs(args)
        const cmd = args[0].toLowerCase().slice(prefix.length)
        switch (cmd) {
            case 'id':
                return void M.reply(M.from)
            case 'time':
                return void M.reply(`${displayIsraelTime()}`)
            case 'list': {
                if (!mods.includes(M.sender)) return void M.reply('Only mods can use it')
                if (!(words.keywords || []).length) return void M.reply('No keywords found')
                const keywordsList = words.keywords.map((word, index) => `${index}. ${word}`).join('\n')
                return void M.reply(`Words List:\n\n${keywordsList}`)
            }
            case 'roles':
            case 'analysis': {
                if (!mods.includes(M.sender)) return void M.reply('Only mods can use it')
                const roles = words.roles || []
                if (!roles.length) return void M.reply('No roles available.')
                let rolesList = '🟩 Word List 🟩'
                rolesList += `\n🍥 Total Categories: ${roles.length}`
                // prettier-ignore
                rolesList += `\n\n${roles
                    .map((role) => `*${Object.keys(role)}:*\n${role[Object.keys(role)].map((word, index) => `${index + 1}. ${word}`).join('\n')}`)
                    .join('\n\n')}`
                return void M.reply(rolesList.trim())
            }
            case 'role':
            case 'categorize': {
                if (!mods.includes(M.sender)) return void M.reply('Only mods can use it')
                if (!context) return void M.reply('Provide a keyword!')
                const [role, element] = context.trim().split('|')
                if (!role || !element) return void M.reply('Do role|element')
                const roles = updateWords(role.trim().toLowerCase(), element)
                return void M.reply(roles === 'OK' ? '🟩 Updated roles' : '🟥 Element not available')
            }
            case 'news':
            case 'state': {
                if (!mods.includes(M.sender)) return void M.reply('Only mods can use it')
                if (!summaries.length) return void M.reply('Pre-generated summaries are not available.')
                if (context && Number(context)) {
                    const collect = summaries.reverse()
                    return void M.reply(`Pre-Summary: ${collect[context - 1]}`)
                }
                const summary = await geminiSummarize(summaries.slice(-10), summaryPrompt)
                console.log('summary: %d of %d', summary.length, summaries.length / 10)
                return void M.reply(summary)
            }
        }
    })

    const reply = async (from, content, type = 'text', caption) => {
        try {
            client.log(`wa_message: ${type}`)
            if (type === 'text' && Buffer.isBuffer(content)) {
                throw new Error('Cannot send a Buffer as a text message')
            }
            return await client.sendMessage(from, {
                [type]: content,
                caption
            })
        } catch (error) {
            client.log(`Failed to send WhatsApp message: ${error.message}`, true)
            if (error.message === 'Connection Closed') {
                client.log('Attempting to reconnect...', true)
                await delay(3000)
                return reply(from, content, type, caption)
            }
        }
    }

    const sendMessage = async (content, type, caption) => {
        try {
            const TypesMap = {
                text: 'sendMessage',
                image: 'sendPhoto',
                video: 'sendVideo'
            }
            const method = TypesMap[type]
            return await bot[method](
                telegramGroup,
                type === 'text' ? caption : content,
                type === 'text' ? {} : { caption }
            )
        } catch (error) {
            client.log(`Failed to send Telegram message: ${error.message}`, true)
        }
    }

    const fetchChannels = async ({ from, channels }) => {
        const promises = channels.map(async (channel) => {
            try {
                const messages = await fetch(channel).catch(() => null)
                if (!messages || !messages.length) return null

                const previousId = store[channel] || 0
                const newMessages = messages.filter((msg) => msg.id > previousId)

                if (newMessages.length > 0) {
                    for (const message of newMessages) {
                        try {
                            addMessage(channel, message)
                            const { type, caption, mediaUrl } = message
                            let text = await transcribe(caption)
                            text = `*${channel}*\n\n${text}`
                            const replyData = type === 'text' ? text : { url: mediaUrl }

                            await sendMessage(mediaUrl, type, text)
                            await reply(from, replyData, type, text)
                        } catch (error) {
                            client.log(`Error processing message: ${error.message}`, true)
                            continue
                        }
                    }

                    store[channel] = newMessages[newMessages.length - 1].id
                    writeFile('store.json', store)
                }
            } catch (error) {
                client.log(`Error processing channel ${channel}: ${error.message}`, true)
            }
        })

        try {
            await Promise.all(promises)
        } catch (error) {
            client.log(`Error in fetchChannels: ${error.message}`, true)
        }
    }

    app.get('/', (req, res) => res.status(200).contentType('image/png').send(client.QR))

    client.ev.on('creds.update', saveCreds)
    return client
}

start()
app.listen(port, () => console.log(`Server started on PORT : ${port}`))
