import { DogePaymentsUtils } from '../src'
import { PRIVATE_KEY, ADDRESS_LEGACY } from './fixtures'
const VALID_ADDRESS = ADDRESS_LEGACY

describe('DogePaymentUtils', () => {
  let pu: DogePaymentsUtils
  beforeEach(() => {
    pu = new DogePaymentsUtils()
  })

  describe('isValidAddress', () => {
    test('should return true for valid', async () => {
      expect(await pu.isValidAddress(VALID_ADDRESS)).toBe(true)
    })
    test('should return false for invalid', async () => {
      expect(await pu.isValidAddress('fake')).toBe(false)
    })
  })

  describe('getFeeEstimate', () => {
    test('should return a value', async () => {
      expect(await pu.getBlockBookFeeEstimate()).toBeDefined()
    })
  })

  describe('isValidExtraId', () => {
    test('should return false', async () => {
      expect(await pu.isValidExtraId('fake')).toBe(false)
    })
  })

  describe('isValidPrivateKey', () => {
    test('should return true for valid', async () => {
      expect(await pu.isValidPrivateKey(PRIVATE_KEY)).toBe(true)
    })
    test('should return false for invalid', async () => {
      expect(await pu.isValidPrivateKey('fake')).toBe(false)
    })
  })

  describe('getPayportValidationMessage', () => {
    it('returns string for empty object', async () => {
      expect(await pu.getPayportValidationMessage({} as any)).toMatch('Invalid payport')
    })
    it('return string for valid address with invalid extraId', async () => {
      expect(await pu.getPayportValidationMessage({ address: VALID_ADDRESS, extraId: '' })).toMatch('Invalid payport')
    })
  })
})
