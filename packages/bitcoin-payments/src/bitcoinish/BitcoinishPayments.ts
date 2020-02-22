import {
  BasePayments, UtxoInfo, FeeOptionCustom, FeeRateType, FeeRate, FeeOption,
  ResolvedFeeOption, FeeLevel, AutoFeeLevels, Payport, ResolveablePayport,
  BalanceResult, FromTo, TransactionStatus, CreateTransactionOptions, BaseConfig,
  WeightedChangeOutput,
} from '@faast/payments-common'
import { isUndefined, isType, Numeric, toBigNumber, assertType, isNumber } from '@faast/ts-common'
import { get } from 'lodash'
import * as t from 'io-ts'

import {
  BitcoinishUnsignedTransaction,
  BitcoinishSignedTransaction,
  BitcoinishBroadcastResult,
  BitcoinishTransactionInfo,
  BitcoinishPaymentsConfig,
  BitcoinishPaymentTx,
  BitcoinishTxOutput,
  BitcoinishWeightedChangeOutput,
  PayportOutput,
} from './types'
import { estimateTxFee, sumUtxoValue, sortUtxos, isConfirmedUtxo } from './utils'
import { BitcoinishPaymentsUtils } from './BitcoinishPaymentsUtils'

export abstract class BitcoinishPayments<Config extends BaseConfig> extends BitcoinishPaymentsUtils
  implements BasePayments<
    Config,
    BitcoinishUnsignedTransaction,
    BitcoinishSignedTransaction,
    BitcoinishBroadcastResult,
    BitcoinishTransactionInfo
  > {
  coinSymbol: string
  coinName: string
  minTxFee?: FeeRate
  dustThreshold: number
  networkMinRelayFee: number
  isSegwit: boolean
  defaultFeeLevel: AutoFeeLevels

  constructor(config: BitcoinishPaymentsConfig) {
    super(config)
    this.coinSymbol = config.coinSymbol
    this.coinName = config.coinName
    this.decimals = config.decimals
    this.bitcoinjsNetwork = config.bitcoinjsNetwork
    this.minTxFee = config.minTxFee
    this.dustThreshold = config.dustThreshold
    this.networkMinRelayFee = config.networkMinRelayFee
    this.isSegwit = config.isSegwit
    this.defaultFeeLevel = config.defaultFeeLevel
  }

  abstract getFullConfig(): Config
  abstract getPublicConfig(): Config
  abstract getAccountId(index: number): string
  abstract getAccountIds(): string[]
  abstract getAddress(index: number): string
  abstract getFeeRateRecommendation(feeLevel: AutoFeeLevels): Promise<FeeRate>
  abstract isValidAddress(address: string): Promise<boolean>
  abstract signTransaction(tx: BitcoinishUnsignedTransaction): Promise<BitcoinishSignedTransaction>

  async init() {}
  async destroy() {}

  requiresBalanceMonitor() {
    return false
  }

  isSweepableBalance(balance: Numeric): boolean {
    return this.toBaseDenominationNumber(balance) > this.networkMinRelayFee
  }

  async getPayport(index: number): Promise<Payport> {
    return { address: this.getAddress(index) }
  }

  async resolvePayport(payport: ResolveablePayport): Promise<Payport> {
    if (typeof payport === 'number') {
      return this.getPayport(payport)
    } else if (typeof payport === 'string') {
      if (!await this.isValidAddress(payport)) {
        throw new Error(`Invalid BTC address: ${payport}`)
      }
      return { address: payport }
    } else if (Payport.is(payport)) {
      if (!await this.isValidAddress(payport.address)) {
        throw new Error(`Invalid BTC payport.address: ${payport.address}`)
      }
      return payport
    } else {
      throw new Error('Invalid payport')
    }
  }

  async resolveFeeOption(
    feeOption: FeeOption,
  ): Promise<ResolvedFeeOption> {
    let targetLevel: FeeLevel
    let target: FeeRate
    let feeBase = ''
    let feeMain = ''
    if (isType(FeeOptionCustom, feeOption)) {
      targetLevel = FeeLevel.Custom
      target = feeOption
    } else {
      targetLevel = feeOption.feeLevel || this.defaultFeeLevel
      target = await this.getFeeRateRecommendation(targetLevel)
    }
    if (target.feeRateType === FeeRateType.Base) {
      feeBase = target.feeRate
      feeMain = this.toMainDenominationString(feeBase)
    } else if (target.feeRateType === FeeRateType.Main) {
      feeMain = target.feeRate
      feeBase = this.toBaseDenominationString(feeMain)
    }
    // in base/weight case total fees depend on input/output count, so just leave them as empty strings
    return {
      targetFeeLevel: targetLevel,
      targetFeeRate: target.feeRate,
      targetFeeRateType: target.feeRateType,
      feeBase,
      feeMain,
    }
  }

  async getBalance(payport: ResolveablePayport): Promise<BalanceResult> {
    const { address } = await this.resolvePayport(payport)
    const result = await this._retryDced(() => this.getApi().getAddressDetails(address, { details: 'basic' }))
    const confirmedBalance = this.toMainDenominationString(result.balance)
    const unconfirmedBalance = this.toMainDenominationString(result.unconfirmedBalance)
    this.logger.debug('getBalance', address, confirmedBalance, unconfirmedBalance)
    return {
      confirmedBalance,
      unconfirmedBalance,
      sweepable: this.isSweepableBalance(confirmedBalance)
    }
  }

  usesUtxos() {
    return true
  }

  async getUtxos(payport: ResolveablePayport): Promise<UtxoInfo[]> {
    const { address } = await this.resolvePayport(payport)
    let utxosRaw = await this.getApi().getUtxosForAddress(address)
    const utxos: UtxoInfo[] = utxosRaw.map((data) => {
      const { value, height, lockTime } = data
      return {
        ...data,
        satoshis: value,
        value: this.toMainDenominationString(value),
        height: isUndefined(height) ? undefined : String(height),
        lockTime: isUndefined(lockTime) ? undefined : String(lockTime),
      }
    })
    return utxos
  }

  usesSequenceNumber() {
    return false
  }

  async getNextSequenceNumber() {
    return null
  }

  async resolveFromTo(from: number, to: ResolveablePayport): Promise<FromTo> {
    const fromPayport = await this.getPayport(from)
    const toPayport = await this.resolvePayport(to)
    return {
      fromAddress: fromPayport.address,
      fromIndex: from,
      fromExtraId: fromPayport.extraId,
      fromPayport,
      toAddress: toPayport.address,
      toIndex: typeof to === 'number' ? to : null,
      toExtraId: toPayport.extraId,
      toPayport,
    }
  }

  /** buildPaymentTx uses satoshi number for convenient math, but we want strings externally */
  private convertOutputsToExternalFormat(outputs: Array<{ address: string, satoshis: number }>): BitcoinishTxOutput[] {
    return outputs.map(({ address, satoshis }) => ({ address, value: this.toMainDenominationString(satoshis) }))
  }

  private feeRateToSatoshis(
    { feeRate, feeRateType }: FeeRate,
    inputCount: number,
    outputCount: number,
  ): number {
    if (feeRateType === FeeRateType.BasePerWeight) {
      return estimateTxFee(Number.parseFloat(feeRate), inputCount, outputCount, this.isSegwit)
    } else if (feeRateType === FeeRateType.Main) {
      return this.toBaseDenominationNumber(feeRate)
    }
    return Number.parseFloat(feeRate)
  }

  private calculateTxFeeSatoshis(
    targetRate: FeeRate,
    inputCount: number,
    outputCount: number,
  ) {
    let feeSat = this.feeRateToSatoshis(targetRate, inputCount, outputCount)
    // Ensure calculated fee is above configured minimum
    if (this.minTxFee) {
      const minTxFeeSat = this.feeRateToSatoshis(this.minTxFee, inputCount, outputCount)
      if (feeSat < minTxFeeSat) {
        feeSat = minTxFeeSat
      }
    }
    if (feeSat < this.networkMinRelayFee) {
      feeSat = this.networkMinRelayFee
    }
    return Math.ceil(feeSat)
  }

  private selectInputUtxos(
    availableUtxos: UtxoInfo[], outputTotal: number, outputCount: number, feeRate: FeeRate, useAllUtxos: boolean,
  ): { selectedUtxos: UtxoInfo[], selectedTotalSat: number, feeSat: number } {
    // Convert values to satoshis for convenient math
    const utxos: Array<UtxoInfo & { satoshis: number }> = []
    let utxosTotalSat = 0
    for (const utxo of availableUtxos) {
      const satoshis = this.toBaseDenominationNumber(utxo.value)
      utxosTotalSat += satoshis
      utxos.push({
        ...utxo,
        satoshis,
      })
    }

    if (useAllUtxos) { // Sweeping case
      return {
        selectedUtxos: utxos,
        selectedTotalSat: utxosTotalSat,
        feeSat: this.calculateTxFeeSatoshis(feeRate, utxos.length, outputCount)
      }
    } else { // Sending amount case
      // First try to find a single input that covers output without creating change
      const idealSolutionFeeSat = this.calculateTxFeeSatoshis(feeRate, 1, outputCount)
      const idealSolutionMinSat = outputTotal + idealSolutionFeeSat
      const idealSolutionMaxSat = idealSolutionMinSat + this.dustThreshold
      for (const utxo of utxos) {
        if (utxo.satoshis >= idealSolutionMinSat && utxo.satoshis <= idealSolutionMaxSat) {
          this.logger.log(
            `Found ideal ${this.coinSymbol} input utxo solution to send ${outputTotal} sat using single utxo ${utxo.txid}:${utxo.vout}`
          )
          return {
            selectedUtxos: [utxo],
            selectedTotalSat: utxo.satoshis,
            feeSat: idealSolutionFeeSat,
          }
        }
      }

      // Select by accumulating smallest utxos first until we cover output + fees
      let selectedUtxos = []
      let selectedTotalSat = 0 // Total input sat is accumulated as inputs are added
      let feeSat = 0 // Total fee is recalculated when adding each input
      const sortedUtxos = sortUtxos(utxos)
      for (const utxo of sortedUtxos) {
        selectedUtxos.push(utxo)
        selectedTotalSat += utxo.satoshis
        feeSat = this.calculateTxFeeSatoshis(feeRate, selectedUtxos.length, outputCount)
        if (selectedTotalSat >= outputTotal + feeSat) {
          break
        }
      }
      return {
        selectedUtxos,
        selectedTotalSat,
        feeSat,
      }
    }
  }

  /**
   * Build a simple payment transaction.
   * Note: fee will be subtracted from first output when attempting to send entire account balance
   * Note: All amounts/values should be input and output as main denomination strings for consistent
   * serialization. Within this function they're converted to JS Numbers for convenient arithmetic
   * then converted back to strings before being returned.
   */
  async buildPaymentTx(params: {
    providedUtxos: UtxoInfo[], // Utxos not already taken by unbroadcast txs
    allUtxos: UtxoInfo[], // All utxos as reported by network
    desiredOutputs: BitcoinishTxOutput[],
    changeAddress: string,
    desiredFeeRate: FeeRate,
    useAllUtxos?: boolean,
    useUnconfirmedUtxos?: boolean,
    minChange?: Numeric, // Main denomination
    targetUtxoPoolSize?: number,
  }): Promise<Required<BitcoinishPaymentTx>> {
    const {
      providedUtxos, allUtxos, desiredOutputs, changeAddress, desiredFeeRate,
    } = params
    const useAllUtxos = isUndefined(params.useAllUtxos) ? false : params.useAllUtxos
    const useUnconfirmedUtxos = isUndefined(params.useUnconfirmedUtxos) ? false : params.useUnconfirmedUtxos
    const targetUtxoPoolSize = isUndefined(params.targetUtxoPoolSize) ? 1 : params.targetUtxoPoolSize
    let minChange = toBigNumber(isUndefined(params.minChange) ? this.dustThreshold : params.minChange)
    if (minChange.lt(0)) {
      throw new Error(`buildPaymentTx - invalid minChange amount ${minChange}, must be positive`)
    }
    // The maximum # of outputs this tx will have. It could have less if some change outputs are dropped
    // for being too small.
    const maxOutputCount = desiredOutputs.length + targetUtxoPoolSize
    // sum of non change output value in satoshis
    let outputTotal = 0
    // Convert output values to satoshis for convenient math
    const externalOutputs: Array<{ address: string, satoshis: number }> = []
    for (let i = 0; i < desiredOutputs.length; i++) {
      const { address, value } = desiredOutputs[i]
      // validate
      if (!await this.isValidAddress(address)) {
        throw new Error(`Invalid ${this.coinSymbol} address ${address} provided for output ${i}`)
      }
      const satoshis = this.toBaseDenominationNumber(value)
      if (isNaN(satoshis)) {
        throw new Error(`Invalid ${this.coinSymbol} value (${value}) provided to createMultiOutputTransaction output ${i} (${address})`)
      }
      if (satoshis <= 0) {
        throw new Error(`Invalid ${this.coinSymbol} positive value (${value}) provided for output ${i} (${address})`)
      }
      externalOutputs.push({ address, satoshis })
      outputTotal += satoshis
    }
    if (!await this.isValidAddress(changeAddress)) {
      throw new Error (`Invalid ${this.coinSymbol} change address ${changeAddress} provided`)
    }

    /* Select inputs and calculate appropriate fee */
    const availableUtxos = !useUnconfirmedUtxos
      ? providedUtxos.filter(isConfirmedUtxo)
      : providedUtxos
    let { selectedUtxos: inputUtxos, selectedTotalSat: inputTotal, feeSat } = this.selectInputUtxos(
      availableUtxos, outputTotal, maxOutputCount, desiredFeeRate, useAllUtxos,
    )
    let amountWithFee = outputTotal + feeSat


    /** Account for insuffient inputs and sweeping cases */
    if (amountWithFee > inputTotal) {
      const amountWithSymbol = `${this.toMainDenominationString(outputTotal)} ${this.coinSymbol}`
      if (outputTotal === inputTotal) { // sweeping
        // Share the fee across all outputs. This may increase the fee by as much as 1 sat per output, negligible
        const feeShare = Math.ceil(feeSat / externalOutputs.length)
        feeSat = feeShare * externalOutputs.length
        this.logger.log(
          `Attempting to send entire ${amountWithSymbol} balance. ` +
          `Subtracting fee of ${feeSat} sat from ${externalOutputs.length} outputs (${feeShare} sat each)`
        )
        for (let i = 0; i < externalOutputs.length; i++) {
          const externalOutput = externalOutputs[i]
          externalOutput.satoshis -= feeShare
          if (externalOutput.satoshis <= this.dustThreshold) {
            throw new Error(`${this.coinSymbol} output ${i} for ${externalOutput.satoshis} sat minus ${feeShare} sat fee share is below dust threshold`)
          }
        }
        amountWithFee = inputTotal
        outputTotal -= feeSat
      } else { // insufficient utxos
        const { feeRate, feeRateType } = desiredFeeRate
        const feeText = `${feeRate} ${feeRateType}${feeRateType === FeeRateType.BasePerWeight ? ` (${this.toMainDenominationString(feeSat)})` : ''}`
        throw new Error(`You do not have enough UTXOs (${this.toMainDenominationString(inputTotal)}) to send ${amountWithSymbol} with ${feeText} fee`)
      }
    }

    /** Change handling */

    let totalChangeSat = inputTotal - amountWithFee
    let changeOutputs: Array<{ address: string, satoshis: number}> = []
    if (totalChangeSat > this.dustThreshold) { // Avoid creating dust outputs

      // Don't use availableUtxo.length here because unconfirmed still count towards pool count
      const remainingUtxoCount = providedUtxos.length - inputUtxos.length
      // Determine how many change outputs to use to maintain target pool size
      const targetChangeOutputCount = remainingUtxoCount < targetUtxoPoolSize
        ? targetUtxoPoolSize - remainingUtxoCount
        : 1

      const changeOutputWeights = this.createWeightedChangeOutputs(targetChangeOutputCount, changeAddress)
      const totalChangeWeight = changeOutputWeights.reduce((total, { weight }) => total += weight, 0)
      let totalChangeAllocated = 0 // Total sat of all change outputs we actually include (omitting dust)
      for (let i = 0; i < changeOutputWeights.length; i++) {
        const { address, weight } = changeOutputWeights[i]
        // Distribute change proportional to each change outputs weight. Floored to not exceed inputTotal
        const changeSat = Math.floor(totalChangeSat * (weight / totalChangeWeight))
        if (changeSat <= this.dustThreshold) {
          this.logger.log(
            `${this.coinSymbol} buildPaymentTx - desired change output ${i} is below dust threshold, will redistribute to other outputs or add to fee`
          )
        } else {
          changeOutputs.push({ address, satoshis: changeSat })
          totalChangeAllocated = changeSat
        }
      }
      // If due to rounding or omitting dust outputs our real change total is different, adjust fees accordingly
      let looseChange = totalChangeSat - totalChangeAllocated
      if (looseChange < 0) {
        throw new Error(`${this.coinSymbol} buildPaymentTx - looseChange should never be negative!`)
      } else if (changeOutputs.length > 0 && looseChange / changeOutputs.length > 1) {
        const extraSatPerChangeOutput = Math.floor(looseChange / changeOutputs.length)
        this.logger.log(`${this.coinSymbol} buildPaymentTx - redistributing looseChange of ${extraSatPerChangeOutput} per change output`)
        for (let i = 0; i < changeOutputs.length; i++) {
          changeOutputs[i].satoshis += extraSatPerChangeOutput
        }
        looseChange -= extraSatPerChangeOutput * changeOutputs.length
      }
      feeSat += looseChange
      totalChangeSat -= looseChange
    } else if (totalChangeSat > 0) {
      this.logger.log(
        `${this.coinSymbol} buildPaymentTx - change of ${totalChangeSat} sat is below dustThreshold of ${this.dustThreshold}, adding to fee`
      )
      feeSat += totalChangeSat
      totalChangeSat = 0
    } else {
      throw new Error(`${this.coinSymbol} buildPaymentTx - totalChangeSat is negative when building tx, this shouldnt happen!`)
    }
    const externalOutputsResult = this.convertOutputsToExternalFormat(externalOutputs)
    const changeOutputsResult = this.convertOutputsToExternalFormat(changeOutputs)
    return {
      inputs: inputUtxos,
      outputs: [...externalOutputsResult, ...changeOutputsResult],
      fee: this.toMainDenominationString(feeSat),
      change: this.toMainDenominationString(totalChangeSat),
      changeAddress: changeOutputs.length === 1 ? changeOutputs[0].address : null, // back compat
      changeOutputs: changeOutputsResult,
      externalOutputs: externalOutputsResult,
      externalOutputTotal: this.toMainDenominationString(outputTotal),
    }
  }

  /**
   * Creates a list of change addresses with an exponential weight distribution to use for
   * maintaining a pool of utxos.
   */
  private createWeightedChangeOutputs(
    changeOutputCount: number,
    changeAddress: string,
  ): BitcoinishWeightedChangeOutput[] {
    const result: BitcoinishWeightedChangeOutput[] = []
    for (let i = 0; i < changeOutputCount; i++) {
      result.push({ address: changeAddress, weight: 2 ** i })
    }
    return result
  }

  async createTransaction(
    from: number,
    to: ResolveablePayport,
    amount: Numeric,
    options?: CreateTransactionOptions,
  ): Promise<BitcoinishUnsignedTransaction> {
    return this.createMultiOutputTransaction(from, [{ payport: to, amount }], options)
  }

  async createMultiOutputTransaction(
    from: number,
    to: PayportOutput[],
    options: CreateTransactionOptions = {},
  ): Promise<BitcoinishUnsignedTransaction> {
    assertType(t.array(PayportOutput), to)
    this.logger.debug('createMultiOutputTransaction', from, to, options)

    const allUtxos = options.allUtxos || await this.getUtxos(from)
    this.logger.debug('createMultiOutputTransaction allUtxos', allUtxos)

    const providedUtxos = options.utxos || allUtxos
    this.logger.debug('createMultiOutputTransaction providedUtxos', providedUtxos)

    const { address: fromAddress } = await this.resolvePayport(from)

    const desiredOutputs = await Promise.all(to.map(async ({ payport, amount }) => ({
      address: (await this.resolvePayport(payport)).address,
      value: String(amount),
    })))

    const { targetFeeLevel, targetFeeRate, targetFeeRateType } = await this.resolveFeeOption(options)
    this.logger.debug(`createTransaction resolvedFeeOption ${targetFeeLevel} ${targetFeeRate} ${targetFeeRateType}`)

    const paymentTx = await this.buildPaymentTx({
      providedUtxos,
      allUtxos,
      desiredOutputs,
      changeAddress: fromAddress,
      desiredFeeRate: { feeRate: targetFeeRate, feeRateType: targetFeeRateType },
      useAllUtxos: options.useAllUtxos,
      targetUtxoPoolSize: options.targetUtxoPoolSize,
    })
    this.logger.debug('createTransaction data', paymentTx)
    const feeMain = paymentTx.fee

    let resultToAddress = 'multi'
    let resultToIndex = null
    if (paymentTx.externalOutputs.length === 1) {
      const onlyOutput = paymentTx.externalOutputs[0]
      resultToAddress = onlyOutput.address
      resultToIndex = isNumber(to[0].payport) ? to[0].payport : null
    }

    return {
      status: TransactionStatus.Unsigned,
      id: null,
      fromIndex: from,
      fromAddress,
      fromExtraId: null,
      toIndex: resultToIndex,
      toAddress: resultToAddress,
      toExtraId: null,
      amount: paymentTx.externalOutputTotal,
      targetFeeLevel,
      targetFeeRate,
      targetFeeRateType,
      fee: feeMain,
      sequenceNumber: null,
      inputUtxos: paymentTx.inputs,
      data: paymentTx,
    }
  }

  async createSweepTransaction(
    from: number,
    to: ResolveablePayport,
    options: CreateTransactionOptions = {},
  ): Promise<BitcoinishUnsignedTransaction> {
    this.logger.debug('createSweepTransaction', from, to, options)

    const allUtxos = await this.getUtxos(from)
    const availableUtxos = isUndefined(options.utxos) ? allUtxos : options.utxos

    if (availableUtxos.length === 0) {
      throw new Error('No available utxos to sweep')
    }
    const outputAmount = sumUtxoValue(availableUtxos)
    if (!this.isSweepableBalance(outputAmount)) {
      throw new Error(`Available utxo total ${outputAmount} ${this.coinSymbol} too low to sweep`)
    }
    const updatedOptions = {
      ...options,
      utxos: availableUtxos,
      useAllUtxos: true,
      allUtxos, // Pass this in to avoid duplicate network requests
    }
    return this.createTransaction(from, to, outputAmount, updatedOptions)
  }

  async broadcastTransaction(tx: BitcoinishSignedTransaction): Promise<BitcoinishBroadcastResult> {
    const txId = await this._retryDced(() => this.getApi().sendTx(tx.data.hex))
    if (tx.id !== txId) {
      this.logger.warn(`Broadcasted ${this.coinSymbol} txid ${txId} doesn't match original txid ${tx.id}`)
    }
    return {
      id: txId,
    }
  }

  async getTransactionInfo(txId: string): Promise<BitcoinishTransactionInfo> {
    const tx = await this._retryDced(() => this.getApi().getTx(txId))
    const fee = this.toMainDenominationString(tx.fees)
    const confirmationId = tx.blockHash || null
    const confirmationNumber = tx.blockHeight ? String(tx.blockHeight) : undefined
    const confirmationTimestamp = tx.blockTime ? new Date(tx.blockTime * 1000) : null
    const isConfirmed = Boolean(confirmationNumber)
    const status = isConfirmed ? TransactionStatus.Confirmed : TransactionStatus.Pending
    const amountSat = get(tx, 'vout.0.value', tx.value)
    const amount = this.toMainDenominationString(amountSat)
    const fromAddress = get(tx, 'vin.0.addresses.0')
    if (!fromAddress) {
      throw new Error(`Unable to determine fromAddress of ${this.coinSymbol} tx ${txId}`)
    }
    const toAddress = get(tx, 'vout.0.addresses.0')
    if (!toAddress) {
      throw new Error(`Unable to determine toAddress of ${this.coinSymbol} tx ${txId}`)
    }

    return {
      status,
      id: tx.txid,
      fromIndex: null,
      fromAddress,
      fromExtraId: null,
      toIndex: null,
      toAddress,
      toExtraId: null,
      amount,
      fee,
      sequenceNumber: null,
      confirmationId,
      confirmationNumber,
      confirmationTimestamp,
      isExecuted: isConfirmed,
      isConfirmed,
      confirmations: tx.confirmations,
      data: tx,
    }
  }
}
