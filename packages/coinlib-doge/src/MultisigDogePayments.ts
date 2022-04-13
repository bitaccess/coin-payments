import { BaseDogePayments } from './BaseDogePayments'
import {
  MultisigDogePaymentsConfig,
  HdDogePaymentsConfig,
  DogeUnsignedTransaction,
  DogeSignedTransaction,
  MultisigAddressType,
  AddressType,
} from './types'

import { omit } from 'lodash'
import { HdDogePayments } from './HdDogePayments'
import { KeyPairDogePayments } from './KeyPairDogePayments'
import * as bitcoin from 'bitcoinjs-lib-bigint'
import { CreateTransactionOptions, ResolveablePayport, PayportOutput } from '@bitaccess/coinlib-common'
import { createMultisigData, combineMultisigData, isMultisigFullySigned} from '@bitaccess/coinlib-bitcoin/src/bitcoinish'

import { getMultisigPaymentScript } from './helpers'

import { Numeric } from '@faast/ts-common'
import { DEFAULT_MULTISIG_ADDRESS_TYPE } from './constants'

export class MultisigDogePayments extends BaseDogePayments<MultisigDogePaymentsConfig> {
  addressType: MultisigAddressType
  m: number
  signers: (HdDogePayments | KeyPairDogePayments)[]
  accountIdToSigner: { [accountId: string]: HdDogePayments | KeyPairDogePayments } = {}

  constructor(private config: MultisigDogePaymentsConfig) {
    super(config)
    this.addressType = config.addressType || DEFAULT_MULTISIG_ADDRESS_TYPE
    this.m = config.m
    this.signers = config.signers.map((signerConfig, i) => {
      signerConfig = {
        network: this.networkType,
        logger: this.logger,
        ...signerConfig,
      }
      if (signerConfig.network !== this.networkType) {
        throw new Error(
          `MultisigDogePayments is on network ${this.networkType} but signer config ${i} is on ${signerConfig.network}`,
        )
      }
      const payments = HdDogePaymentsConfig.is(signerConfig)
        ? new HdDogePayments(signerConfig)
        : new KeyPairDogePayments(signerConfig)

      payments.getAccountIds().forEach(accountId => {
        this.accountIdToSigner[accountId] = payments
      })
      return payments
    })
  }

  getFullConfig(): MultisigDogePaymentsConfig {
    return {
      ...this.config,
      network: this.networkType,
      addressType: this.addressType,
    }
  }

  getPublicConfig(): MultisigDogePaymentsConfig {
    return {
      ...omit(this.getFullConfig(), ['logger', 'server', 'signers']),
      signers: this.signers.map(signer => signer.getPublicConfig()),
    }
  }

  getEstimateTxSizeInputKey() {
    return `${this.addressType}:${this.m}-${this.signers.length}`
  }

  getAccountId(index: number): string {
    throw new Error('Multisig payments does not have single account for an index, use getAccountIds(index) instead')
  }

  getAccountIds(index?: number): string[] {
    return this.signers.reduce((result, signer) => [...result, ...signer.getAccountIds(index)], [] as string[])
  }

  getSignerPublicKeyBuffers(index: number): Buffer[] {
    return this.signers.map(signer => signer.getKeyPair(index).publicKey)
  }

  getPaymentScript(index: number, addressType?: MultisigAddressType): bitcoin.payments.Payment {
    return getMultisigPaymentScript(
      this.bitcoinjsNetwork,
      addressType || this.addressType,
      this.getSignerPublicKeyBuffers(index),
      this.m,
    )
  }

  getAddress(index: number, addressType?: MultisigAddressType): string {
    const { address } = this.getPaymentScript(index, addressType)
    if (!address) {
      throw new Error('bitcoinjs-lib address derivation returned falsy value')
    }
    return address
  }

  async createTransaction(
    from: number,
    to: ResolveablePayport,
    amount: Numeric,
    options?: CreateTransactionOptions,
  ): Promise<DogeUnsignedTransaction> {
    const tx = await super.createTransaction(from, to, amount, options)
    return {
      ...tx,
      multisigData: createMultisigData(tx.inputUtxos!, this.signers, this.m),
    }
  }

  async createMultiOutputTransaction(
    from: number,
    to: PayportOutput[],
    options: CreateTransactionOptions = {},
  ): Promise<DogeUnsignedTransaction> {
    const tx = await super.createMultiOutputTransaction(from, to, options)
    return {
      ...tx,
      multisigData: createMultisigData(tx.inputUtxos!, this.signers, this.m),
    }
  }

  async createMultiInputTransaction(
    from: number[],
    to: PayportOutput[],
    options: CreateTransactionOptions = {},
  ): Promise<DogeUnsignedTransaction> {
    const tx = await super.createMultiInputTransaction(from, to, options)
    return {
      ...tx,
      multisigData: createMultisigData(tx.inputUtxos!, this.signers, this.m),
    }
  }

  async createSweepTransaction(
    from: number,
    to: ResolveablePayport,
    options: CreateTransactionOptions = {},
  ): Promise<DogeUnsignedTransaction> {
    const tx = await super.createSweepTransaction(from, to, options)
    return {
      ...tx,
      multisigData: createMultisigData(tx.inputUtxos!, this.signers, this.m),
    }
  }

  private deserializeSignedTxPsbt(tx: DogeSignedTransaction): bitcoin.Psbt {
    if (!tx.data.partial) {
      throw new Error('Cannot decode psbt of a finalized tx')
    }
    return bitcoin.Psbt.fromHex(tx.data.hex, this.psbtOptions)
  }

  /**
   * Combines two of more partially signed transactions. Once the required # of signatures is reached (`m`)
   * the transaction is validated and finalized.
   */
  async combinePartiallySignedTransactions(txs: DogeSignedTransaction[]): Promise<DogeSignedTransaction> {
    if (txs.length < 2) {
      throw new Error(`Cannot combine ${txs.length} transactions, need at least 2`)
    }
  
    const unsignedTxHash = txs[0].data.unsignedTxHash
    txs.forEach(({ multisigData, inputUtxos, externalOutputs, data }, i) => {
      if (!multisigData) throw new Error(`Cannot combine signed multisig tx ${i} because multisigData is ${multisigData}`)
      if (!inputUtxos) throw new Error(`Cannot combine signed multisig tx ${i} because inputUtxos field is missing`)
      if (!externalOutputs)
        throw new Error(`Cannot combine signed multisig tx ${i} because externalOutputs field is missing`)
      if (data.unsignedTxHash !== unsignedTxHash)
        throw new Error(
          `Cannot combine signed multisig tx ${i} because unsignedTxHash is ${data.unsignedTxHash} when expecting ${unsignedTxHash}`,
        )
      if (!data.partial) throw new Error(`Cannot combine signed multisig tx ${i} because partial is ${data.partial}`)
    })
  
    const baseTx = txs[0]
    const baseTxMultisigData = baseTx.multisigData!
    let updatedMultisigData = baseTxMultisigData
  
    const combinedPsbt = this.deserializeSignedTxPsbt(baseTx)
    for (let i = 1; i < txs.length; i++) {
      if (isMultisigFullySigned(updatedMultisigData)) {
        break
      }
      const tx = txs[i]
      const psbt = this.deserializeSignedTxPsbt(tx)
      combinedPsbt.combine(psbt)
      updatedMultisigData = combineMultisigData(updatedMultisigData, tx.multisigData!)
    }
    return this.updateSignedMultisigTx(baseTx, combinedPsbt, updatedMultisigData)
  }

  async signTransaction(tx: DogeUnsignedTransaction): Promise<DogeSignedTransaction> {
    const partiallySignedTxs = await Promise.all(this.signers.map(signer => signer.signTransaction(tx)))
    return this.combinePartiallySignedTransactions(partiallySignedTxs)
  }

  getSupportedAddressTypes(): AddressType[] {
    return [AddressType.MultisigLegacy]
  }
}

export default MultisigDogePayments