import messaging from '../../relay/messaging_pb'
import stealth from '../../relay/stealth_pb'
import { decrypt, decryptWithEphemPrivKey, decryptEphemeralKey } from '../../relay/crypto'
import { PublicKey } from 'bitcore-lib-cash'
import Vue from 'vue'
import imageUtil from '../../utils/image'
import { insuffientFundsNotify, chainTooLongNotify, desktopNotify } from '../../utils/notifications'
import { defaultStampAmount } from '../../utils/constants'
import { stampPrice } from '../../utils/wallet'
import { constructStealthPaymentPayload, constructImagePayload, constructTextPayload, constructMessage } from '../../relay/constructors'

const cashlib = require('bitcore-lib-cash')

function calculateUnreadAggregates (state, addr) {
  const unreadAggregates = Object.entries(state.data[addr].messages)
    .filter(([timestamp]) => state.data[addr].lastRead < timestamp)
    .map(([timestamp, message]) => {
      return stampPrice(message.outpoints) || 0
    })
    .reduce(
      ({ totalUnreadValue, totalUnreadMessages }, curStampSats) => ({
        totalUnreadValue: totalUnreadValue + curStampSats,
        totalUnreadMessages: totalUnreadMessages + 1
      }),
      {
        totalUnreadValue: 0,
        totalUnreadMessages: 0
      }
    )
  return unreadAggregates
}

export default {
  namespaced: true,
  state: {
    order: [],
    activeChatAddr: null,
    data: {},
    lastReceived: null
  },
  getters: {
    getCurrentReply: (state) => (addr) => {
      let replyIndex = state.data[addr].replyIndex
      if (replyIndex) {
        return state.data[addr].messages[replyIndex]
      }
      return undefined
    },
    containsMessage: (state) => (addr, index) => {
      return (index in state.data[addr].messages)
    },
    getNumUnread: (state) => (addr) => {
      if (state.data[addr].lastRead === null) {
        return Object.keys(state.data[addr].messages).length
      }

      let ids = Object.keys(state.data[addr].messages)
      let lastUnreadIndex = ids.findIndex(id => state.data[addr].lastRead === id)
      let numUnread = ids.length - lastUnreadIndex - 1
      return numUnread
    },
    getLastRead: (state) => (addr) => {
      return state.data[addr].lastRead
    },
    getSortedChatOrder (state) {
      const sortedOrder = state.order.map(
        addr => ({
          address: addr,
          ...calculateUnreadAggregates(state, addr),
          lastRead: state.data[addr].lastRead
        })
      ).sort(({ totalUnreadValue: valueA, lastRead: lastReadA }, { totalUnreadValue: valueB, lastRead: lastReadB }) => {
        if (valueA === valueB) {
          return lastReadB - lastReadA
        }
        return valueB - valueA
      })
      return sortedOrder
    },
    getChatOrder (state) {
      return state.order
    },
    getInputMessage: (state) => (addr) => {
      if (addr in state.data) {
        return state.data[addr].inputMessage
      } else {
        return ''
      }
    },
    getInputMessageActive (state) {
      if (state.activeChatAddr == null) {
        return ''
      } else {
        return state.data[state.activeChatAddr].inputMessage
      }
    },
    getStampAmount: (state) => (addr) => {
      return state.data[addr].stampAmount
    },
    getActiveChat (state) {
      return state.activeChatAddr
    },
    getLatestMessage: (state) => (addr) => {
      let nMessages = Object.keys(state.data[addr].messages).length
      if (nMessages === 0) {
        return null
      }

      let lastMessageKey = Object.keys(state.data[addr].messages)[nMessages - 1]
      let lastMessage = state.data[addr].messages[lastMessageKey]
      let items = lastMessage.items
      let lastItem = items[items.length - 1]

      if (lastItem.type === 'text') {
        let info = {
          outbound: lastMessage.outbound,
          text: lastItem.text
        }
        return info
      }

      if (lastItem.type === 'image') {
        let info = {
          outbound: lastMessage.outbound,
          text: 'Sent image'
        }
        return info
      }

      if (lastItem.type === 'stealth') {
        let info = {
          outbound: lastMessage.outbound,
          text: 'Sent Bitcoin'
        }
        return info
      }
    },
    getAllMessages: (state) => (addr) => {
      if (addr in state.data) {
        return state.data[addr].messages
      } else {
        return {}
      }
    },
    getLastReceived (state) {
      return state.lastReceived
    },
    isChat: (state) => (addr) => {
      return (addr in state.data)
    }
  },
  mutations: {
    setCurrentReply (state, { addr, index }) {
      state.data[addr].currentReply = index
    },
    deleteMessage (state, { addr, id }) {
      Vue.delete(state.data[addr].messages, id)
    },
    reset (state) {
      state.order = []
      state.activeChatAddr = null
      state.data = {}
      state.lastReceived = null
    },
    readAll (state, addr) {
      let ids = Object.keys(state.data[addr].messages)

      if (ids.length === 0) {
        state.data[addr].lastRead = null
      } else {
        state.data[addr].lastRead = ids[ids.length - 1]
      }
    },
    setInputMessage (state, { addr, text }) {
      if (addr in state.data) {
        state.data[addr].inputMessage = text
      }
    },
    setInputMessageActive (state, text) {
      if (state.activeChatAddr != null) {
        state.data[state.activeChatAddr].inputMessage = text
      }
    },
    switchChatActive (state, addr) {
      state.activeChatAddr = addr
    },
    sendMessageLocal (state, { addr, index, items, outpoints }) {
      let timestamp = Date.now()
      let newMsg = {
        type: 'text',
        outbound: true,
        status: 'pending',
        items,
        timestamp,
        outpoints
      }

      Vue.set(state.data[addr].messages, index, newMsg)
    },
    setOutpoints (state, { addr, index, outpoints }) {
      state.data[addr].messages[index].outpoints = outpoints
    },
    setStatus (state, { index, addr, status }) {
      state.data[addr].messages[index].status = status
    },
    setStatusError (state, { index, addr, retryData }) {
      state.data[addr].messages[index].status = 'error'
      Vue.set(state.data[addr].messages[index], 'retryData', retryData)
    },
    switchOrder (state, addr) {
      state.order.splice(state.order.indexOf(addr), 1)
      state.order.unshift(addr)
    },
    clearChat (state, addr) {
      if (addr in state.data) {
        state.data[addr].messages = {}
      }
    },
    deleteChat (state, addr) {
      state.order = state.order.filter(function (value, index, arr) {
        return value !== addr
      })
      if (state.activeChatAddr === addr) {
        state.activeChatAddr = null
      }
      Vue.delete(state.data, addr)
    },
    receiveMessage (state, { addr, index, newMsg }) {
      if (!(addr in state.data)) {
        let messages = {}
        // TODO: Better indexing
        messages[index] = newMsg

        Vue.set(state.data, addr, { messages, inputMessage: '', lastRead: null, stampAmount: defaultStampAmount })
        state.order.unshift(addr)
      } else {
        // TODO: Better indexing
        Vue.set(state.data[addr].messages, index, newMsg)
      }
    },
    setLastReceived (state, lastReceived) {
      state.lastReceived = lastReceived
    },
    openChat (state, addr) {
      if (!(addr in state.data)) {
        Vue.set(state.data, addr, { messages: {}, inputMessage: '', lastRead: null, stampAmount: defaultStampAmount })
        state.order.unshift(addr)
      }
      state.activeChatAddr = addr
    },
    setStampAmount (state, { addr, stampAmount }) {
      state.data[addr].stampAmount = stampAmount
    }
  },
  actions: {
    setCurrentReply ({ commit }, { addr, index }) {
      commit('setCurrentReply', { addr, index })
    },
    deleteMessage ({ commit }, { addr, id }) {
      commit('deleteMessage', { addr, id })
    },
    reset ({ commit }) {
      commit('reset')
    },
    readAll ({ commit }, addr) {
      commit('readAll', addr)
    },
    shareContact ({ commit, rootGetters }, { currentAddr, shareAddr }) {
      let contact = rootGetters['contacts/getContactProfile'](currentAddr)
      let text = 'Name: ' + contact.name + '\n' + 'Address: ' + currentAddr
      commit('setInputMessage', { addr: shareAddr, text })
      commit('switchChatActive', shareAddr)
    },
    setInputMessage ({ commit }, { addr, text }) {
      commit('setInputMessage', { addr, text })
    },
    setInputMessageActive ({ commit }, text) {
      commit('setInputMessageActive', text)
    },
    switchChatActive ({ commit }, addr) {
      commit('switchChatActive', addr)
    },
    startChatUpdater ({ dispatch }) {
      setInterval(() => { dispatch('refresh') }, 1_000)
    },
    async sendMessage ({ commit, rootGetters, getters, dispatch }, { addr, text }) {
      // Send locally
      const items = [
        {
          type: 'text',
          text
        }
      ]

      const privKey = rootGetters['wallet/getIdentityPrivKey']
      const destPubKey = rootGetters['contacts/getPubKey'](addr)
      const stampAmount = getters['getStampAmount'](addr)

      // Construct payload
      const { payload, payloadDigest } = constructTextPayload(text, privKey, destPubKey, 1)

      // Add localy
      commit('sendMessageLocal', { addr, index: payloadDigest, items, outpoints: null })

      // Construct message
      try {
        var { message, usedIDs, stampTx } = await constructMessage(payload, privKey, destPubKey, stampAmount)
      } catch (err) {
        console.error(err)
        insuffientFundsNotify()
        commit('setStatusError', { addr, index: payloadDigest, retryData: { msgType: 'text', text } })
        return
      }
      let messageSet = new messaging.MessageSet()
      messageSet.addMessages(message)

      let destAddr = destPubKey.toAddress('testnet').toLegacyAddress()
      let client = rootGetters['relayClient/getClient']

      try {
        // Send to destination address
        await client.pushMessages(destAddr, messageSet)
        let outpoint = {
          stampTx,
          vouts: [0]
        }
        commit('setOutpoints', { addr, index: payloadDigest, outpoints: [outpoint] })
        commit('setStatus', { addr, index: payloadDigest, status: 'confirmed' })
      } catch (err) {
        console.error(err.response)
        // Unfreeze UTXOs
        // TODO: More subtle
        usedIDs.forEach(id => dispatch('wallet/fixFrozenUTXO', id, { root: true }))

        chainTooLongNotify()
        commit('setStatusError', { addr, index: payloadDigest, retryData: { msgType: 'text', text } })
      }
    },
    async sendStealthPayment ({ commit, rootGetters, getters, dispatch }, { addr, amount, memo, stamptxId }) {
      // Send locally
      const items = [
        {
          type: 'stealth',
          amount
        }
      ]
      if (memo !== '') {
        items.push(
          {
            type: 'text',
            text: memo
          })
      }

      const privKey = rootGetters['wallet/getIdentityPrivKey']
      const destPubKey = rootGetters['contacts/getPubKey'](addr)
      const stampAmount = getters['getStampAmount'](addr)

      // Construct payload
      const { payload, payloadDigest } = await constructStealthPaymentPayload(amount, memo, privKey, destPubKey, 1, stamptxId)

      // Add localy
      commit('sendMessageLocal', { addr, index: payloadDigest, items, outpoints: null })

      try {
        var { message, usedIDs, stampTx } = await constructMessage(payload, privKey, destPubKey, stampAmount)
      } catch (err) {
        console.error(err)
        insuffientFundsNotify()
        commit('setStatusError', { addr, index: payloadDigest, retryData: { msgType: 'stealth', amount, memo, stamptxId } })
        return
      }
      let messageSet = new messaging.MessageSet()
      messageSet.addMessages(message)

      let destAddr = destPubKey.toAddress('testnet').toLegacyAddress()
      let client = rootGetters['relayClient/getClient']
      try {
        await client.pushMessages(destAddr, messageSet)
        commit('setStampTx', { addr, index: payloadDigest, stampTx })
        commit('setStatus', { addr, index: payloadDigest, status: 'confirmed' })
      } catch (err) {
        // Unfreeze UTXOs
        // TODO: More subtle
        usedIDs.forEach(id => dispatch('wallet/unfreezeUTXO', id, { root: true }))

        chainTooLongNotify()
        commit('setStatusError', { addr, index: payloadDigest, retryData: { msgType: 'stealth', amount, memo } })
      }
    },
    async sendImage ({ commit, rootGetters, getters, dispatch }, { addr, image, caption }) {
      // Send locally
      const items = [
        {
          type: 'image',
          image
        }
      ]
      if (caption !== '') {
        items.push(
          {
            type: 'text',
            text: caption
          })
      }

      const privKey = rootGetters['wallet/getIdentityPrivKey']
      const destPubKey = rootGetters['contacts/getPubKey'](addr)
      const stampAmount = getters['getStampAmount'](addr)

      // Construct payload
      const { payload, payloadDigest } = constructImagePayload(image, caption, privKey, destPubKey, 1)

      // Add localy
      commit('sendMessageLocal', { addr, index: payloadDigest, items, outpoints: null })

      // Construct message
      try {
        var { message, usedIDs, stampTx } = await constructMessage(payload, privKey, destPubKey, stampAmount)
      } catch (err) {
        console.error(err)

        insuffientFundsNotify()
        commit('setStatusError', { addr, index: payloadDigest, retryData: { msgType: 'image', image, caption } })
        return
      }
      let messageSet = new messaging.MessageSet()
      messageSet.addMessages(message)

      let destAddr = destPubKey.toAddress('testnet').toLegacyAddress()
      let client = rootGetters['relayClient/getClient']
      try {
        await client.pushMessages(destAddr, messageSet)
        commit('setStampTx', { addr, index: payloadDigest, stampTx })
        commit('setStatus', { addr, index: payloadDigest, status: 'confirmed' })
      } catch (err) {
        // Unfreeze UTXOs
        // TODO: More subtle
        usedIDs.forEach(id => dispatch('wallet/unfreezeUTXO', id, { root: true }))

        chainTooLongNotify()
        commit('setStatusError', { addr, index: payloadDigest, retryData: { msgType: 'image', image, caption } })
      }
    },
    switchOrder ({ commit }, addr) {
      commit('switchOrder', addr)
    },
    clearChat ({ commit }, addr) {
      commit('clearChat', addr)
    },
    deleteChat ({ commit }, addr) {
      commit('deleteChat', addr)
    },
    async receiveMessage ({ commit, getters, rootGetters, dispatch }, { message, timestamp }) {
      const rawSenderPubKey = message.getSenderPubKey()
      const senderPubKey = cashlib.PublicKey.fromBuffer(rawSenderPubKey)
      const senderAddr = senderPubKey.toAddress('testnet').toCashAddress() // TODO: Make generic
      const myAddress = rootGetters['wallet/getMyAddressStr']
      const outbound = (senderAddr === myAddress)

      const rawPayload = message.getSerializedPayload()
      let payload

      // Get payload if serialized payload is missing
      if (rawPayload.length === 0) {
        const payloadDigest = message.getPayloadDigest()
        if (payloadDigest.length === 0) {
          // TODO: Handle
          return
        }

        // Get relay client
        let relayClient = rootGetters['relayClient/getClient']
        try {
          let token = rootGetters['relay/getToken']
          payload = await relayClient.getPayload(senderAddr, token, payloadDigest)
        } catch (err) {
          console.error(err)
          // TODO: Handle
          return
        }
      } else {
        payload = messaging.Payload.deserializeBinary(rawPayload)
      }

      const desintationRaw = payload.getDestination()
      const destPubKey = cashlib.PublicKey.fromBuffer(desintationRaw)
      const destinationAddr = destPubKey.toAddress('testnet').toCashAddress()

      // Check whether pre-existing
      const payloadDigest = cashlib.crypto.Hash.sha256(rawPayload)
      if (outbound) {
        if (getters['containsMessage'](destinationAddr, payloadDigest)) {
          return
        }
      } else {
        if (getters['containsMessage'](senderAddr, payloadDigest)) {
          return
        }
      }

      if (outbound && myAddress === destinationAddr) {
        // TODO: Process self sends
        console.log('self send')
        return
      }

      // Check whether contact exists
      if (outbound) {
        if (!rootGetters['contacts/isContact'](destinationAddr)) {
          // Add dummy contact
          dispatch('contacts/addLoadingContact', { addr: destinationAddr, pubKey: destPubKey }, { root: true })

          // Load contact
          dispatch('contacts/refresh', destinationAddr, { root: true })
        }
      } else {
        if (!rootGetters['contacts/isContact'](senderAddr)) {
          // Add dummy contact
          dispatch('contacts/addLoadingContact', { addr: senderAddr, pubKey: senderPubKey }, { root: true })

          // Load contact
          dispatch('contacts/refresh', senderAddr, { root: true })
        }
      }

      let scheme = payload.getScheme()
      let entriesRaw
      if (scheme === 0) {
        entriesRaw = payload.getEntries()
      } else if (scheme === 1) {
        let entriesCipherText = payload.getEntries()

        let ephemeralPubKeyRaw = payload.getEphemeralPubKey()
        let ephemeralPubKey = PublicKey.fromBuffer(ephemeralPubKeyRaw)
        let privKey = rootGetters['wallet/getIdentityPrivKey']
        if (!outbound) {
          entriesRaw = decrypt(entriesCipherText, privKey, senderPubKey, ephemeralPubKey)
        } else {
          let ephemeralPrivKeyEncrypted = payload.getEphemeralPrivKey()
          let entriesDigest = cashlib.crypto.Hash.sha256(entriesCipherText)
          let ephemeralPrivKey = decryptEphemeralKey(ephemeralPrivKeyEncrypted, privKey, entriesDigest)
          entriesRaw = decryptWithEphemPrivKey(entriesCipherText, ephemeralPrivKey, privKey, destPubKey)
        }
      } else {
        // TODO: Raise error
      }

      // Add UTXO
      let stampOutpoints = message.getStampOutpointsList()
      let outpoints = []
      for (let i in stampOutpoints) {
        let stampOutpoint = stampOutpoints[i]
        let stampTxRaw = Buffer.from(stampOutpoint.getStampTx())
        let stampTx = cashlib.Transaction(stampTxRaw)
        let txId = stampTx.hash
        let vouts = stampOutpoint.getVoutsList()
        outpoints.push({
          stampTx,
          vouts
        })
        for (let j in vouts) {
          let outputIndex = vouts[j]
          let output = stampTx.outputs[outputIndex]
          let satoshis = output.satoshis
          let address = output.script.toAddress('testnet').toLegacyAddress() // TODO: Make generic
          let stampOutput = {
            address,
            outputIndex,
            satoshis,
            txId,
            type: 'stamp',
            payloadDigest
          }
          dispatch('wallet/addUTXO', stampOutput, { root: true })
        }
      }

      // Decode entries
      let entries = messaging.Entries.deserializeBinary(entriesRaw)
      let entriesList = entries.getEntriesList()
      let newMsg = {
        outbound,
        status: 'confirmed',
        items: [],
        timestamp,
        outpoints
      }
      for (let index in entriesList) {
        let entry = entriesList[index]
        // If addr data doesn't exist then add it
        let kind = entry.getKind()
        if (kind === 'reply') {
          let payloadDigest = entry.entryData()
          newMsg.items.push({
            type: 'reply',
            payloadDigest
          })
        } else if (kind === 'text-utf8') {
          let entryData = entry.getEntryData()
          let text = new TextDecoder().decode(entryData)
          newMsg.items.push({
            type: 'text',
            text
          })

          // If not focused (and not outbox message) then notify
          if (!document.hasFocus() && !outbound) {
            let contact = rootGetters['contacts/getContact'](senderAddr)
            if (contact.notify) {
              desktopNotify(contact.keyserver.name, text, contact.keyserver.avatar, () => {
                dispatch('openChat', senderAddr)
              })
            }
          }
        } else if (kind === 'stealth-payment') {
          let entryData = entry.getEntryData()
          let stealthMessage = stealth.StealthPaymentEntry.deserializeBinary(entryData)

          let electrumHandler = rootGetters['electrumHandler/getClient']

          let txId = Buffer.from(stealthMessage.getTxId()).toString('hex')
          try {
            var txRaw = await electrumHandler.methods.blockchain_transaction_get(txId)
          } catch (err) {
            console.error(err)
            // TODO: Awaiting confirmation check
            // TODO: Logic relating to this
          }
          let tx = cashlib.Transaction(txRaw)

          // Add stealth output
          let output = tx.outputs[0]
          let address = output.script.toAddress('testnet').toLegacyAddress() // TODO: Make generic
          let ephemeralPubKey = stealthMessage.getEphemeralPubKey()
          let stealthOutput = {
            address,
            outputIndex: 0, // TODO: 0 is always stealth output, change this assumption?
            satoshis: output.satoshis,
            txId,
            type: 'stealth',
            ephemeralPubKey
          }
          dispatch('wallet/addUTXO', stealthOutput, { root: true })
          newMsg.items.push({
            type: 'stealth',
            amount: output.satoshis
          })
        } else if (kind === 'image') {
          let image = imageUtil.entryToImage(entry)

          // TODO: Save to folder instead of in Vuex
          newMsg.items.push({
            type: 'image',
            image
          })
        }
      }

      if (outbound) {
        commit('receiveMessage', { addr: destinationAddr, index: payloadDigest, newMsg })
      } else {
        commit('receiveMessage', { addr: senderAddr, index: payloadDigest, newMsg })
      }
    },
    async refresh ({ commit, rootGetters, getters, dispatch }) {
      let myAddressStr = rootGetters['wallet/getMyAddressStr']
      let client = rootGetters['relayClient/getClient']
      let lastReceived = getters['getLastReceived'] || 0

      // If token is null then purchase one
      let token = rootGetters['relayClient/getToken']

      let messagePage = await client.getMessages(myAddressStr, token, lastReceived, null)
      let messageList = messagePage.getMessagesList()

      for (let index in messageList) {
        let timedMessage = messageList[index]

        // TODO: Check correct destination
        // let destPubKey = timedMessage.getDestination()

        let timestamp = timedMessage.getServerTime()
        let message = timedMessage.getMessage()
        await dispatch('receiveMessage', { timestamp, message })
        lastReceived = Math.max(lastReceived, timestamp)
      }
      if (lastReceived) {
        commit('setLastReceived', lastReceived + 1)
      }
    },
    openChat ({ commit }, addr) {
      commit('openChat', addr)
    },
    setStampAmount ({ commit }, { addr, stampAmount }) {
      commit('setStampAmount', { addr, stampAmount })
    }
  }
}
