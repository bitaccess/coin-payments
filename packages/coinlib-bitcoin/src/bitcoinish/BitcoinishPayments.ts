import { NormalizedTxBitcoin } from 'blockbook-client';
import {
  BasePayments,
  UtxoInfo,
  FeeOptionCustom,
  FeeRateType,
  FeeRate,
  FeeOption,
  ResolvedFeeOption,
  FeeLevel,
  AutoFeeLevels,
  Payport,
  ResolveablePayport,
  DerivablePayport,
  BalanceResult,
  FromTo,
  TransactionStatus,
  CreateTransactionOptions,
  BaseConfig,
  PayportOutput,
  TransactionOutput,
  PaymentsError,
  PaymentsErrorCode,
  DEFAULT_MAX_FEE_PERCENT,
} from '@bitaccess/coinlib-common'
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
  BitcoinishTxBuildContext,
  BitcoinishBuildPaymentTxParams,
  UtxoInfoWithSats,
  AddressType,
} from './types'
import { sumUtxoValue, shuffleUtxos, isConfirmedUtxo, sha256FromHex, sumField } from './utils'
import { BitcoinishPaymentsUtils } from './BitcoinishPaymentsUtils'
import BigNumber from 'bignumber.js'

export abstract class BitcoinishPayments<Config extends BaseConfig> extends BitcoinishPaymentsUtils
  implements BasePayments<
    Config,
    BitcoinishUnsignedTransaction,
    BitcoinishSignedTransaction,
    BitcoinishBroadcastResult,
    BitcoinishTransactionInfo
  > {
  minTxFee?: FeeRate
  dustThreshold: number // base denom
  defaultFeeLevel: AutoFeeLevels
  targetUtxoPoolSize: number
  minChangeSat: number
  abstract addressType: AddressType | null

  constructor(config: BitcoinishPaymentsConfig) {
    super(config)
    this.minTxFee = config.minTxFee
    this.dustThreshold = config.dustThreshold
    this.defaultFeeLevel = config.defaultFeeLevel
    this.targetUtxoPoolSize = isUndefined(config.targetUtxoPoolSize) ? 1 : config.targetUtxoPoolSize

    const minChange = toBigNumber(isUndefined(config.minChange) ? 0 : config.minChange)
    if (minChange.lt(0)) {
      throw new Error(`invalid minChange amount ${config.minChange}, must be positive`)
    }
    this.minChangeSat = this.toBaseDenominationNumber(minChange)
  }

  abstract getFullConfig(): Config
  abstract getPublicConfig(): Config
  abstract getAccountId(index: number): string
  abstract getAccountIds(index?: number): string[]
  abstract getSupportedAddressTypes(): AddressType[] | null
  abstract getAddress(index: number, addressType?: AddressType): string
  abstract signTransaction(tx: BitcoinishUnsignedTransaction): Promise<BitcoinishSignedTransaction>

  /**
   * Serialize the payment tx into an hex string format representing the unsigned transaction.
   *
   * By default return empty string because it's coin dependent. Implementors can override this
   * with coin specific implementation (eg using Psbt for bitcoin). If coin doesn't have an unsigned
   * serialized tx format (ie most coins other than BTC) then leave as empty string.
   */
  abstract serializePaymentTx(paymentTx: BitcoinishPaymentTx, fromIndex?: number): Promise<string>

  async init() {}
  async destroy() {}

  requiresBalanceMonitor() {
    return false
  }

  async getPayport(index: number): Promise<Payport> {
    return { address: this.getAddress(index) }
  }

  getAddressType(address: string, index: number): AddressType {
    const standartizedAddress = this.standardizeAddress(address)
    for (let addressType of this.getSupportedAddressTypes()!) {
      if (standartizedAddress === this.getAddress(index, addressType)) {
        return addressType
      }
    }
    throw new Error(`Failed to identify address ${address} at index ${index}`)
  }

  async resolvePayport(payport: ResolveablePayport): Promise<Payport> {
    if (typeof payport === 'number') {
      return this.getPayport(payport)
    } else if (typeof payport === 'string') {
      if (!this.isValidAddress(payport)) {
        throw new Error(`Invalid ${this.coinSymbol} address: ${payport}`)
      }
      return { address: this.standardizeAddress(payport)! }
    } else if (Payport.is(payport)) {
      if (!this.isValidAddress(payport.address)) {
        throw new Error(`Invalid ${this.coinSymbol} payport.address: ${payport.address}`)
      }
      return { ...payport, address: this.standardizeAddress(payport.address)! }
    } else if (DerivablePayport.is(payport)) {
      let { addressType = this.addressType } = payport
      return { address: this.getAddress(payport.index, addressType as AddressType) }
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
    return this.getAddressBalance(address)
  }

  isSweepableBalance(balance: Numeric) {
    return this.isAddressBalanceSweepable(balance)
  }

  usesUtxos() {
    return true
  }

  async getUtxos(payport: ResolveablePayport): Promise<UtxoInfo[]> {
    const { address } = await this.resolvePayport(payport)
    const utxos = await this.getAddressUtxos(address)

    if (typeof payport === 'number') {
      utxos.forEach((u: UtxoInfo) => u.signer = payport)
    } else if (DerivablePayport.is(payport)) {
      utxos.forEach((u: UtxoInfo) => u.signer = payport.index)
    }

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

  /**
   * Estimate the size of a tx in vbytes. Override this if the coin supports segwit, multisig, or any
   * non P2PKH style transaction. Default implementation assumes P2PKH.
   */
  estimateTxSize(
    inputCount: number,
    changeOutputCount: number,
    externalOutputAddresses: string[],
  ): number {
    return 10 + 148 * inputCount + 34 * (changeOutputCount + externalOutputAddresses.length)
  }

  /** Helper for calculateTxFeeSatoshis */
  private feeRateToSatoshis(
    { feeRate, feeRateType }: FeeRate,
    inputCount: number,
    changeOutputCount: number,
    externalOutputAddresses: string[],
  ): number {
    if (feeRateType === FeeRateType.BasePerWeight) {
      const estimatedTxSize = this.estimateTxSize(inputCount, changeOutputCount, externalOutputAddresses)
      this.logger.debug(`${this.coinSymbol} buildPaymentTx - `
        + `Estimated tx size of ${estimatedTxSize} vbytes for a tx with ${inputCount} inputs, `
        + `${externalOutputAddresses.length} external outputs, and ${changeOutputCount} change outputs`
      )
      return Number.parseFloat(feeRate) * estimatedTxSize
    } else if (feeRateType === FeeRateType.Main) {
      return this.toBaseDenominationNumber(feeRate)
    }
    return Number.parseFloat(feeRate)
  }

  /** Estimate the tx fee in satoshis */
  private estimateTxFee(
    targetRate: FeeRate,
    inputCount: number,
    changeOutputCount: number,
    externalOutputAddresses: string[],
  ): number {
    let feeSat = this.feeRateToSatoshis(targetRate, inputCount, changeOutputCount, externalOutputAddresses)
    // Ensure calculated fee is above configured minimum
    if (this.minTxFee) {
      const minTxFeeSat = this.feeRateToSatoshis(this.minTxFee, inputCount, changeOutputCount, externalOutputAddresses)
      if (feeSat < minTxFeeSat) {
        this.logger.debug(`Using min tx fee of ${minTxFeeSat} sat (${this.minTxFee} sat/byte) instead of ${feeSat} sat`)
        feeSat = minTxFeeSat
      }
    }
    // Ensure calculated fee is above network relay minimum
    if (feeSat < this.networkMinRelayFee) {
      this.logger.debug(`Using network min relay fee of ${this.networkMinRelayFee} sat instead of ${feeSat} sat`)
      feeSat = this.networkMinRelayFee
    }
    const result = Math.ceil(feeSat)
    this.logger.debug(`${this.coinSymbol} buildPaymentTx - `
      + `Estimated fee of ${result} sat for target rate ${targetRate.feeRate} ${targetRate.feeRateType} for a tx with `
      + `${inputCount} inputs, ${externalOutputAddresses.length} external outputs, and ${changeOutputCount} change outputs`
    )
    return result
  }

  /**
   * Determine how many change outputs to add to a transaction given how many there are currently
   * and how many we intend to use. The goal is to keep at least `targetUtxoPoolSize` utxos available
   * at all times to increase availability.
   */
  private determineTargetChangeOutputCount(unusedUtxoCount: number, inputUtxoCount: number) {
    const remainingUtxoCount = unusedUtxoCount - inputUtxoCount
    const additionalUtxosNeeded = remainingUtxoCount < this.targetUtxoPoolSize
      ? this.targetUtxoPoolSize - remainingUtxoCount
      : 1
    // Only create at most (1 + input count) change outputs to amortize fee burden
    return Math.min(additionalUtxosNeeded, inputUtxoCount + 1)
  }

  /** Adjust all the output amounts such that externalOutputTotal equals newOutputTotal (+/- a few satoshis less) */
  private adjustOutputAmounts(
    tbc: BitcoinishTxBuildContext,
    newOutputTotal: number,
    description: string,
    newError = (m: string) => new Error(m),
  ): void {
    // positive adjustment -> increase outputs
    // negative adjustment -> decrease outputs
    const totalBefore = tbc.externalOutputTotal
    let totalAdjustment = newOutputTotal - totalBefore
    // Share the adjustment across all outputs. This may be an extra 1 less sat per output, negligible
    const outputCount = tbc.externalOutputs.length
    const amountChangePerOutput = Math.floor(totalAdjustment / outputCount)
    totalAdjustment = amountChangePerOutput * outputCount
    this.logger.log(
      `${this.coinSymbol} buildPaymentTx - Adjusting external output total (${tbc.externalOutputTotal} sat) by ${totalAdjustment} sat `
      + `across ${outputCount} outputs (${amountChangePerOutput} sat each) for ${description}`
    )
    for (let i = 0; i < outputCount; i++) {
      const externalOutput = tbc.externalOutputs[i]
      // Explicitly check value before subtracting for an accurate error message
      if (externalOutput.satoshis + amountChangePerOutput <= this.dustThreshold) {
        const errorMessage = `${this.coinSymbol} buildPaymentTx - output ${i} for ${externalOutput.satoshis} sat `
          + `after ${description} of ${amountChangePerOutput} sat is too small to send`

        if (externalOutput.satoshis + amountChangePerOutput <= 0) {
          throw newError(errorMessage)
        }

        throw newError(`${errorMessage} (below dust threshold of ${this.dustThreshold} sat)`)
      }
      externalOutput.satoshis += amountChangePerOutput
    }
    tbc.externalOutputTotal += totalAdjustment
    this.logger.log(
      `${this.coinSymbol} buildPaymentTx - Adjusted external output total from ${totalBefore} sat to ${tbc.externalOutputTotal} sat for ${description}`
    )
  }

  private adjustTxFee(tbc: BitcoinishTxBuildContext, newFeeSat: number, description: string): void {
    // Apply a hard limit on the maximum fee to avoid overpaying
    if (newFeeSat > Math.ceil(tbc.desiredOutputTotal * (tbc.maxFeePercent / 100))) {
      throw new PaymentsError(
        PaymentsErrorCode.TxFeeTooHigh,
        `${description} (${newFeeSat} sat) exceeds maximum fee percent (${tbc.maxFeePercent}%) `
          + `of desired output total (${tbc.desiredOutputTotal} sat)`
      )
    }
    let feeSatAdjustment = newFeeSat - tbc.feeSat
    if (!tbc.recipientPaysFee && !tbc.isSweep) {
      this.applyFeeAdjustment(tbc, feeSatAdjustment, description)
      return
    }
    this.adjustOutputAmounts(
      tbc,
      tbc.externalOutputTotal - feeSatAdjustment,
      description,
      (m) => new PaymentsError(PaymentsErrorCode.TxFeeTooHigh, m),
    )
    this.applyFeeAdjustment(tbc, feeSatAdjustment, description)
  }

  private applyFeeAdjustment(tbc: BitcoinishTxBuildContext, feeSatAdjustment: number, description: string): void {
    const feeBefore = tbc.feeSat
    tbc.feeSat += feeSatAdjustment
    this.logger.log(`${this.coinSymbol} buildPaymentTx - Adjusted fee from ${feeBefore} sat to ${tbc.feeSat} sat for ${description}`)
    return
  }

  /* Select inputs, calculate appropriate fee, set fee, adjust output amounts if necessary */
  private selectInputUtxos(tbc: BitcoinishTxBuildContext): void {
    if (tbc.useAllUtxos) { // Sweeping or consolidation case
      this.selectInputUtxosForAll(tbc)
    } else { // Sending amount case
      this.selectInputUtxosPartial(tbc)
    }

    // insufficient utxos
    if (tbc.externalOutputTotal + tbc.feeSat > tbc.inputTotal) {
      throw new PaymentsError(
        PaymentsErrorCode.TxInsufficientBalance,
        `${this.coinSymbol} buildPaymentTx - You do not have enough UTXOs (${tbc.inputTotal} sat) ` +
        `to send ${tbc.externalOutputTotal} sat with ${tbc.feeSat} sat fee`
      )
    }
  }

  private selectInputUtxosForAll(tbc: BitcoinishTxBuildContext) {
    for (const utxo of tbc.enforcedUtxos) {
      tbc.inputTotal += utxo.satoshis
      tbc.inputUtxos.push(utxo)
    }

    for (const utxo of tbc.selectableUtxos) {
      if (tbc.inputUtxos.map((u) => `${u.txid}${u.vout}`).includes(`${utxo.txid}${utxo.vout}`)) {
        continue
      }
      tbc.inputTotal += utxo.satoshis
      tbc.inputUtxos.push(utxo)
    }

    if (tbc.isSweep && tbc.inputTotal !== tbc.externalOutputTotal) {
      // Some dust inputs were filtered
      this.adjustOutputAmounts(tbc, tbc.inputTotal, 'dust inputs filtering')
    }
    const feeSat = this.estimateTxFee(tbc.desiredFeeRate, tbc.inputUtxos.length, 0, tbc.externalOutputAddresses)
    this.adjustTxFee(tbc, feeSat, 'sweep fee')
  }

  private selectInputUtxosPartial(tbc: BitcoinishTxBuildContext) {
    if (tbc.enforcedUtxos && tbc.enforcedUtxos.length > 0) {
      return this.selectWithForcedUtxos(tbc)
    } else {
      return this.selectFromAvailableUtxos(tbc)
    }
  }

  private estimateIdealUtxoSelectionFee(tbc: BitcoinishTxBuildContext, inputCount: number) {
    return this.estimateTxFee(
      tbc.desiredFeeRate,
      inputCount,
      0,
      tbc.externalOutputAddresses
    )
  }

  /** Ideal utxo selection is one which creates no change outputs */
  private isIdealUtxoSelection(tbc: BitcoinishTxBuildContext, utxosSelected: UtxoInfoWithSats[]): boolean {
    const idealSolutionFeeSat = this.estimateIdealUtxoSelectionFee(tbc, utxosSelected.length)
    const idealSolutionMinSat = tbc.desiredOutputTotal + (tbc.recipientPaysFee ? 0 : idealSolutionFeeSat)
    const idealSolutionMaxSat = idealSolutionMinSat + this.dustThreshold
    let selectedTotal = 0
    for (let utxo of utxosSelected) {
      selectedTotal += utxo.satoshis
    }
    return selectedTotal >= idealSolutionMinSat && selectedTotal <= idealSolutionMaxSat
  }

  private selectWithForcedUtxos(tbc: BitcoinishTxBuildContext) {
    for (const utxo of tbc.enforcedUtxos) {
      tbc.inputTotal += utxo.satoshis
      tbc.inputUtxos.push(utxo)
    }

    // Check if an ideal solution is possible
    if (this.isIdealUtxoSelection(tbc, tbc.inputUtxos)) {
      const idealSolutionFeeSat = this.estimateIdealUtxoSelectionFee(tbc, tbc.inputUtxos.length)
      this.adjustTxFee(tbc, idealSolutionFeeSat, 'forced inputs ideal solution fee')
      return
    }

    // Check if we have enough forced inputs to cover fee when change outputs are added
    const targetChangeOutputCount = this.determineTargetChangeOutputCount(
      tbc.nonDustUtxoCount,
      tbc.inputUtxos.length,
    )
    const feeSat = this.estimateTxFee(
      tbc.desiredFeeRate,
      tbc.inputUtxos.length,
      targetChangeOutputCount,
      tbc.externalOutputAddresses,
    )
    const minimumSat = tbc.desiredOutputTotal + (tbc.recipientPaysFee ? 0 : feeSat)
    if (tbc.inputTotal >= minimumSat) {
      this.adjustTxFee(tbc, feeSat, 'forced inputs fee')
      return
    }

    // Not enough forced inputs to cover fee, select additional utxos
    this.selectFromAvailableUtxos(tbc)
  }

  private selectFromAvailableUtxos(
    tbc: BitcoinishTxBuildContext,
  ) {
    // Ideal solution consists of a single additional input that covers outputs without creating change
    for (const utxo of tbc.selectableUtxos) {
      if (this.isIdealUtxoSelection(tbc, [...tbc.inputUtxos, utxo])) {
        tbc.inputUtxos.push(utxo)
        tbc.inputTotal += utxo.satoshis
        const idealSolutionFeeSat = this.estimateIdealUtxoSelectionFee(tbc, tbc.inputUtxos.length)
        this.logger.log(`${this.coinSymbol} buildPaymentTx - `
          + `Found ideal ${this.coinSymbol} input utxo solution to send ${tbc.desiredOutputTotal} sat `
          + `${tbc.recipientPaysFee ? 'less' : 'plus'} fee of ${idealSolutionFeeSat} sat `
          + `using single utxo ${utxo.txid}:${utxo.vout}`
        )
        this.adjustTxFee(tbc, idealSolutionFeeSat, 'ideal solution fee')
        return
      }
    }

    let feeSat = 0
    // Incrementally select utxos until we cover outputs and fees
    for (const utxo of shuffleUtxos(tbc.selectableUtxos)) {
      tbc.inputUtxos.push(utxo)
      tbc.inputTotal += utxo.satoshis

      const targetChangeOutputCount = this.determineTargetChangeOutputCount(
        tbc.nonDustUtxoCount,
        tbc.inputUtxos.length,
      )
      feeSat = this.estimateTxFee(
        tbc.desiredFeeRate,
        tbc.inputUtxos.length,
        targetChangeOutputCount,
        tbc.externalOutputAddresses,
      )
      const neededSat = tbc.externalOutputTotal + (tbc.recipientPaysFee ? 0 : feeSat)
      if (tbc.inputTotal >= neededSat) {
        break
      }
    }

    this.adjustTxFee(tbc, feeSat, 'selected inputs fee')
  }

  private allocateChangeOutputs(tbc: BitcoinishTxBuildContext): void {
    tbc.totalChange = tbc.inputTotal - tbc.externalOutputTotal - tbc.feeSat
    if (tbc.totalChange < 0) {
      throw new Error(`${this.coinSymbol} buildPaymentTx - totalChange is negative when building tx, this shouldnt happen!`)
    }
    if (tbc.totalChange === 0) {
      this.logger.debug(`${this.coinSymbol} buildPaymentTx - no change to allocate`)
      return
    }
    const targetChangeOutputCount = this.determineTargetChangeOutputCount(
      tbc.nonDustUtxoCount,
      tbc.inputUtxos.length,
    )
    // Sort ascending by weight so we can drop small change outputs first and reduce total weight to avoid loose change
    const changeOutputWeights = this.createWeightedChangeOutputs(targetChangeOutputCount, tbc.changeAddress)

    // Total sat of all change outputs we actually include (omitting dust)
    const totalChangeAllocated = this.allocateChangeUsingWeights(tbc, changeOutputWeights)
    let changeOutputCount = tbc.changeOutputs.length

    // Amount of change not yet added to a change output
    let looseChange = tbc.totalChange - totalChangeAllocated
    if (changeOutputCount < targetChangeOutputCount) {
      // If due to rounding or omitting dust outputs we have fewer change outputs than expected, adjust fees accordingly
      looseChange = this.readjustTxFeeAfterDroppingChangeOutputs(
        tbc,
        changeOutputCount,
        totalChangeAllocated,
        looseChange
      )
    }

    // Attempt to allocate any loose change to existing change outputs, or a single change output
    if (looseChange < 0) {
      throw new Error(`${this.coinSymbol} buildPaymentTx - looseChange should never be negative!`)
    }

    if (changeOutputCount > 0 && looseChange > 0) {
      // Enough loose change to reallocate amongst all change outputs
      looseChange = this.reallocateLooseChange(tbc, changeOutputCount, looseChange)
    } else if (changeOutputCount === 0 && looseChange > this.dustThreshold) {
      this.logger.log(`${this.coinSymbol} buildPaymentTx - allocating all loose change towards single ${looseChange} sat change output`)
      tbc.changeOutputs.push({ address: tbc.changeAddress[0], satoshis: looseChange })

      changeOutputCount += 1
      looseChange = 0
    }

    // If there is still a negligible amount of loose change just add it to the first change output
    if (looseChange > 0) {
      if (looseChange > this.dustThreshold) {
        throw new Error(
          `${this.coinSymbol} buildPaymentTx - Ended up with loose change (${looseChange} sat) exceeding dust threshold, this should never happen!`
        )
      }
      // Don't adjust external output amounts here like other fee adjustments because loose change has already been
      // deducted from the outputs
      this.applyFeeAdjustment(tbc, looseChange, 'loose change allocation')
      tbc.totalChange -= looseChange
      looseChange = 0
    }
  }

  private validateBuildContext(tbc: BitcoinishTxBuildContext) {
    const inputSum = sumField(tbc.inputUtxos, 'satoshis')
    if (!inputSum.eq(tbc.inputTotal)) {
      throw new Error(`${this.coinSymbol} buildPaymentTx - invalid context: input utxo sum ${inputSum} doesn't equal inputTotal ${tbc.inputTotal}`)
    }
    const externalOutputSum = sumField(tbc.externalOutputs, 'satoshis')
    if (!externalOutputSum.eq(tbc.externalOutputTotal)) {
      throw new Error(`${this.coinSymbol} buildPaymentTx - invalid context: external output sum ${externalOutputSum} doesn't equal externalOutputTotal ${tbc.externalOutputTotal}`)
    }
    const changeOutputSum = sumField(tbc.changeOutputs, 'satoshis')
    if (!changeOutputSum.eq(tbc.totalChange)) {
      throw new Error(`${this.coinSymbol} buildPaymentTx - invalid context: change output sum ${changeOutputSum} doesn't equal totalChange ${tbc.totalChange}`)
    }
    const actualFee = inputSum.minus(externalOutputSum).minus(changeOutputSum)
    if (!actualFee.eq(tbc.feeSat)) {
      throw new Error(`${this.coinSymbol} buildPaymentTx - invalid context: inputs minus outputs sum ${actualFee} doesn't equal feeSat ${tbc.feeSat}`)
    }
  }

  private omitDustUtxos(utxos: UtxoInfo[], feeRate: FeeRate): UtxoInfoWithSats[] {
    const utxoSpendCost = this.estimateTxFee(feeRate, 1, 0, [])
      - this.estimateTxFee(feeRate, 0, 0, [])
    return this.prepareUtxos(utxos).filter((utxo) => {
      if (utxo.satoshis > utxoSpendCost) {
        return true
      }
      this.logger.log(`${this.coinSymbol} buildPaymentTx - Ignoring dust utxo (${utxoSpendCost} sat or lower) ${utxo.txid}:${utxo.vout}`)
    })
  }

  /**
   * Build a simple payment transaction.
   * Note: fee will be subtracted from first output when attempting to send entire account balance
   * Note: All amounts/values should be input and output as main denomination strings for consistent
   * serialization. Within this function they're converted to JS Numbers for convenient arithmetic
   * then converted back to strings before being returned.
   */
  async buildPaymentTx(params: BitcoinishBuildPaymentTxParams): Promise<Required<BitcoinishPaymentTx>> {
    const nonDustUtxos = this.omitDustUtxos(params.unusedUtxos, params.desiredFeeRate)

    const tbc: BitcoinishTxBuildContext = {
      ...params,
      desiredOutputTotal: 0,
      externalOutputs: [],
      externalOutputTotal: 0,
      externalOutputAddresses: [],
      isSweep: false,
      inputUtxos: [],
      inputTotal: 0,
      feeSat: 0,
      totalChange: 0,
      changeOutputs: [],
      unusedUtxos: this.prepareUtxos(params.unusedUtxos),
      enforcedUtxos: this.prepareUtxos(params.enforcedUtxos),
      nonDustUtxoCount: nonDustUtxos.length,
      selectableUtxos: nonDustUtxos
        .filter((utxo) => (params.useUnconfirmedUtxos || isConfirmedUtxo(utxo)))
        .filter((utxo) => !params.enforcedUtxos.find((u) => u.txid === utxo.txid && u.vout === utxo.vout ))
    }

    for (let i = 0; i < tbc.desiredOutputs.length; i++) {
      const { address: unvalidatedAddress, value } = tbc.desiredOutputs[i]
      // validate
      if (!this.isValidAddress(unvalidatedAddress)) {
        throw new Error(`Invalid ${this.coinSymbol} address ${unvalidatedAddress} provided for output ${i}`)
      }
      const address = this.standardizeAddress(unvalidatedAddress)!
      const satoshis = this.toBaseDenominationNumber(value)
      if (isNaN(satoshis) || satoshis <= 0) {
        throw new Error(`Invalid ${this.coinSymbol} value (${value}) provided for output ${i} (${address}) - not a positive, non-zero number`)
      }
      if (satoshis <= this.dustThreshold) {
        throw new Error(`Invalid ${this.coinSymbol} value (${value}) provided for output ${i} (${address}) - below dust threshold (${this.dustThreshold} sat)`)
      }
      tbc.externalOutputs.push({ address, satoshis })
      tbc.externalOutputAddresses.push(address)
      tbc.externalOutputTotal += satoshis
      tbc.desiredOutputTotal += satoshis
    }
    for (let address of tbc.changeAddress) {
      if (!this.isValidAddress(address)) {
        throw new Error (`Invalid ${this.coinSymbol} change address ${address} provided`)
      }
    }
    const unfilteredUtxoTotal = sumUtxoValue(params.unusedUtxos, params.useUnconfirmedUtxos)
    // TODO: createSweepTransaction could just pass this in directly
    tbc.isSweep = tbc.useAllUtxos && tbc.desiredOutputTotal >= unfilteredUtxoTotal.toNumber()

    this.selectInputUtxos(tbc)
    tbc.inputUtxos = tbc.inputUtxos.sort((a, b) => `${a.txid}${a.vout}` > `${b.txid}${b.vout}` && 1 || -1)

    this.logger.debug(`${this.coinSymbol} buildPaymentTx - context after utxo input selection`, tbc)

    this.allocateChangeOutputs(tbc)
    this.logger.debug(`${this.coinSymbol} buildPaymentTx - context after allocating change outputs`, tbc)

    const estimatedWeight = this.estimateTxSize(
      tbc.inputUtxos.length,
      tbc.changeOutputs.length,
      tbc.externalOutputAddresses,
    )

    this.validateBuildContext(tbc)

    const externalOutputsResult = this.convertOutputsToExternalFormat(tbc.externalOutputs)
    const changeOutputsResult = this.convertOutputsToExternalFormat(tbc.changeOutputs)
    const outputsResult = [...externalOutputsResult, ...changeOutputsResult]
    return {
      inputs: tbc.inputUtxos,
      inputTotal: this.toMainDenominationString(tbc.inputTotal),
      outputs: outputsResult,
      fee: this.toMainDenominationString(tbc.feeSat),
      change: this.toMainDenominationString(tbc.totalChange),
      changeAddress: tbc.changeOutputs.length === 1 ? tbc.changeOutputs[0].address : null, // back compat
      changeOutputs: changeOutputsResult,
      externalOutputs: externalOutputsResult,
      externalOutputTotal: this.toMainDenominationString(tbc.externalOutputTotal),
      weight: estimatedWeight,
      rawHex: '',
      rawHash: '',
    }
  }

  /**
   * Creates a list of change addresses with an exponential weight distribution to use for
   * maintaining a pool of utxos.
   */
  private createWeightedChangeOutputs(
    changeOutputCount: number,
    changeAddress: string[],
  ): BitcoinishWeightedChangeOutput[] {
    const result: BitcoinishWeightedChangeOutput[] = []
    for (let i = 0; i < changeOutputCount; i++) {
      result.push({
        address: changeAddress[i % changeAddress.length],
        weight: 2 ** i
      })
    }
    return result.sort((a, b) => a.weight - b.weight)
  }

  private allocateChangeUsingWeights(
    tbc: BitcoinishTxBuildContext,
    changeOutputWeights: BitcoinishWeightedChangeOutput[]
  ): number {
    let totalChangeWeight = sumField(changeOutputWeights, 'weight').toNumber()
    let totalChangeAllocated = 0 // Total sat of all change outputs we actually include (omitting dust)
    for (let i = 0; i < changeOutputWeights.length; i++) {
      const { address, weight } = changeOutputWeights[i]
      // Distribute change proportional to each change outputs weight. Floored to not exceed inputTotal
      const changeSat = Math.floor(tbc.totalChange * (weight / totalChangeWeight))
      if (changeSat <= this.dustThreshold || changeSat < this.minChangeSat) {
        this.logger.debug(
          `${this.coinSymbol} buildPaymentTx - desired change output ${i} with weight `
          + `${weight}/${totalChangeWeight} is below dust threshold or minChange, `
          + `reducing total weight to ${totalChangeWeight - weight}`
        )
        totalChangeWeight -= weight
      } else {
        tbc.changeOutputs.push({ address, satoshis: changeSat })
        totalChangeAllocated += changeSat
      }
    }

    this.logger.debug(
      `${this.coinSymbol} buildPaymentTx`,
      { changeOutputWeights, totalChangeWeight, totalChangeAllocated, changeOutputs: tbc.changeOutputs },
    )

    return totalChangeAllocated
  }

  private readjustTxFeeAfterDroppingChangeOutputs(
    tbc: BitcoinishTxBuildContext,
    changeOutputCount: number,
    totalChangeAllocated: number,
    looseChange: number
  ): number {
    const recalculatedFee = this.estimateTxFee(
      tbc.desiredFeeRate,
      tbc.inputUtxos.length,
      changeOutputCount || 1, // minimum one change output for loose change
      tbc.externalOutputAddresses,
    )
    if (tbc.feeSat <= recalculatedFee) {
      return looseChange
    }

    // Due to dropping change outputs we're now overpaying, reduce fee and reallocate to change
    const looseChangeBefore = looseChange
    this.adjustTxFee(tbc, recalculatedFee, 'dropped change outputs recalculated fee')
    // Recalculate total and loose change because fee adjustments may alter output amount
    tbc.totalChange = tbc.inputTotal - tbc.externalOutputTotal - tbc.feeSat
    looseChange = tbc.totalChange - totalChangeAllocated
    this.logger.log(
      `${this.coinSymbol} buildPaymentTx - Adjusted looseChange from `
      + `${looseChangeBefore} sat to ${looseChange} sat after `
      + 'applying dropped change outputs recalculated fee'
    )

    return looseChange
  }

  private reallocateLooseChange(tbc: BitcoinishTxBuildContext, changeOutputCount: number, looseChange: number): number {
    const extraSatPerChangeOutput = Math.floor(looseChange / changeOutputCount)
    if (extraSatPerChangeOutput > 0) {
      this.logger.log(
        `${this.coinSymbol} buildPaymentTx - allocating ${extraSatPerChangeOutput * changeOutputCount} sat loose change `
        + `across ${changeOutputCount} change outputs (${extraSatPerChangeOutput} sat each)`
      )
      for (let i = 0; i < changeOutputCount; i++) {
        tbc.changeOutputs[i].satoshis += extraSatPerChangeOutput
      }
      looseChange -= extraSatPerChangeOutput * changeOutputCount
    }

    if (looseChange > 0) {
      this.logger.log(`${this.coinSymbol} buildPaymentTx - allocating `
        + `${looseChange} sat loose change to first change output`)
      // A few satoshis are leftover due to rounding, give it to the first change output
      tbc.changeOutputs[0].satoshis += looseChange
      looseChange = 0
    }

    return looseChange
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

    const unusedUtxos = options.availableUtxos || await this.getUtxos(from)
    this.logger.debug('createMultiOutputTransaction unusedUtxos', unusedUtxos)

    const { address: fromAddress } = await this.resolvePayport(from)

    const desiredOutputs = await Promise.all(to.map(async ({ payport, amount }) => ({
      address: (await this.resolvePayport(payport)).address,
      value: String(amount),
    })))

    const maxFeePercent = new BigNumber(options.maxFeePercent ?? DEFAULT_MAX_FEE_PERCENT).toNumber()
    const { targetFeeLevel, targetFeeRate, targetFeeRateType } = await this.resolveFeeOption(options)
    this.logger.debug('createMultiOutputTransaction resolvedFeeOption '
      + `${targetFeeLevel} ${targetFeeRate} ${targetFeeRateType}`)

    let changeAddress = [fromAddress]
    if (options.changeAddress) {
      if(Array.isArray(options.changeAddress)) {
        changeAddress = options.changeAddress
      } else {
        changeAddress = [options.changeAddress]
      }
    } else {
      let { address } = await this.resolvePayport(from)
      changeAddress = [address]
    }
    const paymentTx = await this.buildPaymentTx({
      unusedUtxos,
      enforcedUtxos: options.forcedUtxos || [],
      desiredOutputs,
      changeAddress,
      desiredFeeRate: { feeRate: targetFeeRate, feeRateType: targetFeeRateType },
      useAllUtxos: options.useAllUtxos ?? false,
      useUnconfirmedUtxos: options.useUnconfirmedUtxos ?? false,
      recipientPaysFee: options.recipientPaysFee ?? false,
      maxFeePercent,
    })
    const unsignedTxHex = await this.serializePaymentTx(paymentTx, from)
    paymentTx.rawHex = unsignedTxHex
    paymentTx.rawHash = sha256FromHex(unsignedTxHex)
    this.logger.debug('createMultiOutputTransaction data', paymentTx)
    const feeMain = paymentTx.fee

    let resultToAddress = 'batch'
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
      weight: paymentTx.weight,
      sequenceNumber: null,
      inputUtxos: paymentTx.inputs,
      externalOutputs: paymentTx.externalOutputs,
      data: paymentTx,
    }
  }

  async createServiceTransaction(
    from: number,
    options: CreateTransactionOptions = {},
  ): Promise<null> {
    return null
  }

  async createSweepTransaction(
    from: number,
    to: ResolveablePayport,
    options: CreateTransactionOptions = {},
  ): Promise<BitcoinishUnsignedTransaction> {
    this.logger.debug('createSweepTransaction', from, to, options)

    const availableUtxos = isUndefined(options.availableUtxos)
      ? await this.getUtxos(from)
      : options.availableUtxos
    const forcedUtxos = isUndefined(options.forcedUtxos) ? [] : options.forcedUtxos

    if (availableUtxos.length === 0 && forcedUtxos.length === 0) {
      throw new Error(`No available utxos to sweep available: ${availableUtxos.length}, forced: ${forcedUtxos}`)
    }
    const useUnconfirmedUtxos = isUndefined(options.useUnconfirmedUtxos) ? true : options.useUnconfirmedUtxos
    const outputAmount = sumUtxoValue(availableUtxos, useUnconfirmedUtxos).plus(sumUtxoValue(forcedUtxos, true))
    if (!this.isSweepableBalance(outputAmount)) {
      throw new Error(`Available utxo total ${outputAmount} ${this.coinSymbol} too low to sweep`)
    }
    const updatedOptions = {
      ...options,
      useUnconfirmedUtxos,
      utxos: availableUtxos,
      useAllUtxos: true,
    }
    return this.createTransaction(from, to, outputAmount, updatedOptions)
  }

  async createMultiInputTransaction(
    from: number[],
    to: PayportOutput[],
    options: CreateTransactionOptions = {},
  ): Promise<BitcoinishUnsignedTransaction> {
    assertType(t.array(PayportOutput), to)
    this.logger.debug('createMultiInputTransaction', from, to, options)

    const unusedUtxos = []
    if (options.availableUtxos) {
      for (let u of options.availableUtxos) {
        unusedUtxos.push(u)
      }
    } else {
      for(let f of from) {
        unusedUtxos.push(...(await this.getUtxos(f)))
      }
    }
    this.logger.debug('createMultiInputTransaction unusedUtxos', unusedUtxos)

    let changeAddress: string[]
    if (options.changeAddress) {
      if(Array.isArray(options.changeAddress)) {
        changeAddress = options.changeAddress
      } else {
        changeAddress = [options.changeAddress]
      }
    } else {
      let { address } = await this.resolvePayport(from[0])
      changeAddress = [address]
    }

    const desiredOutputs = await Promise.all(to.map(async ({ payport, amount }) => ({
      address: (await this.resolvePayport(payport)).address,
      value: String(amount),
    })))

    const maxFeePercent = new BigNumber(options.maxFeePercent ?? DEFAULT_MAX_FEE_PERCENT).toNumber()
    const { targetFeeLevel, targetFeeRate, targetFeeRateType } = await this.resolveFeeOption(options)
    this.logger.debug(`createMultiInputTransaction resolvedFeeOption ${targetFeeLevel} `
      + `${targetFeeRate} ${targetFeeRateType}`)

    const paymentTx = await this.buildPaymentTx({
      unusedUtxos,
      enforcedUtxos: options.forcedUtxos || [],
      desiredOutputs,
      changeAddress,
      desiredFeeRate: { feeRate: targetFeeRate, feeRateType: targetFeeRateType },
      useAllUtxos: options.useAllUtxos ?? false,
      useUnconfirmedUtxos: options.useUnconfirmedUtxos ?? false,
      recipientPaysFee: options.recipientPaysFee ?? false,
      maxFeePercent,
    })

    const unsignedTxHex = await this.serializePaymentTx(paymentTx)
    paymentTx.rawHex = unsignedTxHex
    paymentTx.rawHash = sha256FromHex(unsignedTxHex)
    this.logger.debug('createMultiInputTransaction data', paymentTx)
    const feeMain = paymentTx.fee

    let resultToAddress = 'batch'
    let resultToIndex = null
    if (paymentTx.externalOutputs.length === 1) {
      const onlyOutput = paymentTx.externalOutputs[0]
      resultToAddress = onlyOutput.address
      resultToIndex = isNumber(to[0].payport) ? to[0].payport : null
    }

    return {
      status: TransactionStatus.Unsigned,
      id: null,
      fromIndex: null,
      fromAddress: 'batch',
      fromExtraId: null,
      toIndex: resultToIndex,
      toAddress: resultToAddress,
      toExtraId: null,
      amount: paymentTx.externalOutputTotal,
      targetFeeLevel,
      targetFeeRate,
      targetFeeRateType,
      fee: feeMain,
      weight: paymentTx.weight,
      sequenceNumber: null,
      inputUtxos: paymentTx.inputs,
      externalOutputs: paymentTx.externalOutputs,
      data: paymentTx,
    }
  }

  async broadcastTransaction(tx: BitcoinishSignedTransaction): Promise<BitcoinishBroadcastResult> {
    let txId: string
    try {
      txId = await this._retryDced(() => this.getApi().sendTx(tx.data.hex))
      if (tx.id !== txId) {
        this.logger.warn(`Broadcasted ${this.coinSymbol} txid ${txId} doesn't match original txid ${tx.id}`)
      }
    } catch(e) {
      const message = e.message || ''
      if (message.startsWith('-27')) {
        txId = tx.id
      } else {
        throw e
      }
    }
    return {
      id: tx.id,
    }
  }

  private prepareUtxos(utxos: UtxoInfo[]): Array<UtxoInfo & { satoshis: number }> {
    return utxos.map((utxo) => {
      return {
        ...utxo,
        satoshis: isUndefined(utxo.satoshis)
          ? this.toBaseDenominationNumber(utxo.value)
          : toBigNumber(utxo.satoshis).toNumber()
      }
    })
  }
}