const {
    default: Baileys,
    delay,
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState
} = require('@whiskeysockets/baileys')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const { imageSync } = require('qr-image')
const { schedule } = require('node-cron')
const { Boom } = require('@hapi/boom')
const app = require('express')()
const chalk = require('chalk')
const fs = require('fs-extra')
const P = require('pino')
const { fetch, transcribe, formatSeconds, geminiSummarize } = require('./lib/utils')

// configuration
const port = process.env.PORT || 3000
const adminGroup = process.env.ADMIN || ''
const apiKey = process.env.GEMINI_KEY || '' // get: => https://makersuite.google.com/app/apikey
const mods = (process.env.MODS || '923224875937').split(', ').map((jid) => `${jid}@s.whatsapp.net`)

// gemini-ai getting access to apikey
const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: 'gemini-1.5-flash' })

// ensuring file function
const readFile = (path, value = {}) =>
    fs.existsSync(path) ? fs.readJSONSync(path) : (fs.outputJSONSync(path, value), value)

// required files
const groups = readFile('groups.json', [])
const store = readFile('store.json')
const words = readFile('words.json')
const messageStone = readFile('messages.json')

// load all channels
const getChannels = () => {
    groups.forEach((group) => {
        group.channels = group.channels.map((channel) => channel.toLowerCase())
    })
    fs.writeJSONSync('groups.json', groups, { spaces: 2 })
}

// remove invalid channel username
const removeInvalidChannel = (from, channel) => {
    const group = groups.find((group) => group.from === from)
    const index = group.channels.indexOf(channel.toLowerCase())
    group.channels.splice(index, 1)
    fs.writeJSONSync('groups.json', groups, { spaces: 2 })
}

// adding messages with unique id
const addMessage = (channel, content) => {
    ;(messageStone[channel] = messageStone[channel] || []).push(content)
    fs.writeJSONSync('messages.json', messageStone, { spaces: 2 })
}

// updating store file function
const saveStore = (store) => fs.writeJSONSync('store.json', store, { spaces: 2 })

// saving unique words in words.json
const saveWords = async (content) => {
    words.keywords = words.keywords || []
    words.keywords = [...new Set([...words.keywords, ...(Array.isArray(content) ? content : [])])]
    fs.writeJSONSync('words.json', words, { spaces: 2 })
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
    fs.writeJSONSync('words.json', words, { spaces: 2 })
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
                await fs.remove('session')
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
                const totalChannels = groups.reduce((sum, group) => sum + group.channels.length, 0)
                const delayPerChannel = Math.floor((20 * 60 * 1000) / totalChannels)
                client.log(`Total Channels: ${totalChannels}, Delay per Channel: ${formatSeconds(delayPerChannel)}`)
                const scheduleFetch = () => {
                    for (const group of groups) {
                        for (let i = 0; i < group.channels.length; i++) {
                            setTimeout(
                                () => fetchChannels({ from: group.from, channels: [group.channels[i]] }),
                                i * delayPerChannel
                            )
                        }
                    }
                }
                // initial fetch channels
                scheduleFetch()
                // schedule fetch channels every 20 minutes
                schedule('*/20 * * * *', scheduleFetch)

                // summarize channels messages in 1hr chunks
                const summarizeChannels = async () => {
                    if (!apikey || !Object.keys(messageStone).length) {
                        console.log(apikey ? 'messageStone is empty. No channels to summarize.' : 'Gemini-ai Apikey required')
                        return null
                    }
                    try {
                        for (const channel in messageStone) {
                            const messages = messageStone[channel].map((content) => content.caption)
                            const summary = await geminiSummarize(model, messages)
                            await client.sendMessage(adminGroup, { text: `${channel}\n\n${summary}` })
                            delete messageStone[channel]
                        }
                        fs.writeJSONSync('messages.json', messageStone, { spaces: 2 })
                    } catch (error) {
                        console.error('Error in summarizeChannels:', error.message)
                    }
                }
                // schedule summarize channels every 1hr
                schedule('0 * * * *', summarizeChannels)
            }
        }
    })

    client.ev.on('messages.upsert', async ({ messages }) => {
        const formatArgs = (args) => args.slice(1).join(' ').trim()
        const prefix = '/'
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
                rolesList += `\n\n${roles
                    .map((role) => `*${Object.keys(role)}:*\n${role[Object.keys(role)].map((word, index) => `${index + 1}. ${word}`).join('\n')}`)
                    .join('\n\n')}`
                return void M.reply(rolesList.trim())
            }
            case 'role':
            case 'categorize': {
                if (!mods.includes(M.sender)) return void M.reply('Only mods can use it')
                if (!context) return void M.reply('Provide a keyword, Baka!')
                const [role, element] = context.trim().split('|')
                if (!role || !element) return void M.reply('Do role|element')
                const roles = updateWords(role.trim().toLowerCase(), element)
                return void M.reply(roles === 'OK' ? '🟩 Updated roles' : '🟥 Element not available')
            }
        }
    })

    const reply = async (from, content, type = 'text', caption) => {
        client.log(`wa_message: ${type}`)
        if (type === 'text' && Buffer.isBuffer(content)) throw new Error('Cannot send a Buffer as a text message')
        return client.sendMessage(from, {
            [type]: content,
            caption
        })
    }

    const fetchChannels = async ({ from, channels }) => {
        const promises = channels.map(async (channel) => {
            client.log(`Checking... ${chalk.yellowBright(channel)}`)
            const messages = await fetch(channel).catch(() => {
                client.log('API is busy at the moment, try again later', true)
                return void null
            })
            if (!messages.length) {
                // removeInvalidChannel(from, channel)
                client.log(`Invalid ${channel} removed`, true)
                return void null
            }
            const previousId = store[channel] || 0
            const index = messages.findIndex((message) => message.id === previousId)
            if ((previousId && index === -1) || previousId > messages.pop().id) {
                client.log(`Json is Outdated of ${channel}`, true)
                store[channel] = messages.pop().id
                saveStore(store)
                return void null
            }
            if (index !== -1) {
                const messagesToSend = messages.slice(index + 1)
                if (!messagesToSend.length) {
                    client.log(`No new messages ${channel}`)
                    return void null
                }
                messagesToSend.forEach(async (message, messageIndex) => {
                    addMessage(channel, message)
                    const { type, caption, mediaUrl } = message
                    let text = await transcribe(caption)
                    text = `*${channel}*\n\n${text}`
                    const replyData = type === 'text' ? text : { url: mediaUrl }
                    await delay(5000 * messageIndex)
                    await reply(from, replyData, type, text)
                })
                store[channel] = messagesToSend.pop().id
                saveStore(store)
            }
            if (!previousId && messages.length) {
                client.log(`Channel store: ${chalk.yellowBright(channel)}`)
                const firstMessage = messages.pop()
                addMessage(channel, firstMessage)
                const { id, type, caption, mediaUrl } = firstMessage
                let text = await transcribe(caption)
                text = `*${channel}*\n\n${text}`
                store[channel] = id
                saveStore(store)
                const replyData = type === 'text' ? text : { url: mediaUrl }
                await reply(from, replyData, type, text)
            }
        })
        await Promise.all(promises)
    }

    app.get('/', (req, res) => res.status(200).contentType('image/png').send(client.QR))

    client.ev.on('creds.update', saveCreds)
    return client
}

start()
app.listen(port, () => console.log(`Server started on PORT : ${port}`))
