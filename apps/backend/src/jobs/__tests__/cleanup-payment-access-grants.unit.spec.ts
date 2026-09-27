const runMock = jest.fn()

jest.mock("../../workflows/payment-access/purge-expired-payment-access", () => ({
  purgeExpiredPaymentAccessWorkflow: jest.fn(() => ({ run: (...args: unknown[]) => runMock(...args) })),
}))

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import cleanupPaymentAccessGrants, { config } from "../cleanup-payment-access-grants"

describe("cleanup-payment-access-grants job", () => {
  function container() {
    const logger = { info: jest.fn() }
    return {
      logger,
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.LOGGER) return logger
        throw new Error(`Unexpected resolve: ${key}`)
      },
    }
  }

  it("runs the purge workflow and logs only the number of removed grants", async () => {
    runMock.mockResolvedValue({ result: 3 })
    const c = container()

    await cleanupPaymentAccessGrants(c as any)

    expect(runMock).toHaveBeenCalledWith({ input: {} })
    expect(c.logger.info).toHaveBeenCalledTimes(1)
    expect(c.logger.info.mock.calls[0][0]).toBe("payment_access cleanup: removed 3 expired/revoked grant(s)")
    expect(c.logger.info.mock.calls[0][0]).not.toMatch(/pat_|pag_|payses_|hash/)
  })

  it("is scheduled daily under a stable name", () => {
    expect(config).toEqual({ name: "cleanup-payment-access-grants", schedule: "30 3 * * *" })
  })
})
