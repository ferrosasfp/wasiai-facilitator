// FIXTURE DE CONTRATO — ORIGEN (provider /settle). WKH-227 / HU-SOL-24, sync: 2026-07-22.
// Body EIP-3009 canónico que VerifyRequestSchema/SettleRequestSchema aceptan. Es el punto de
// encuentro cross-repo: chaski-v3 (consumer) vendorea una COPIA y compara el body que arma
// broadcastSettle() SALVO el `nonce` (consumer-generado, ver nota abajo). NO editar a mano.
// Amounts = decimal STRING (AC-5).
export const settleEip3009Body = {
  x402Version: 2, // z.literal(2) — el NÚMERO, no "2"
  resource: { url: 'https://chaski.example/api/settle' },
  accepted: {
    scheme: 'exact',
    network: 'eip155:84532', // eip155:<chainId>
    amount: '400000000', // uint256 decimal STRING (AC-5) — 400 USDC (6 dec)
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC Base Sepolia (0x-hex, AddressHex)
    payTo: '0x1111111111111111111111111111111111111111',
    maxTimeoutSeconds: 60,
    extra: { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2' },
  },
  payload: {
    signature: '0x' + 'ab'.repeat(65), // 65-byte 0x-hex (pasa el regex de PayloadSchema)
    authorization: {
      from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // AddressHex (checksum)
      to: '0x1111111111111111111111111111111111111111',
      value: '400000000', // == accepted.amount (decimal string)
      validAfter: '0',
      validBefore: '1893456000', // decimal string
      nonce: '0x' + 'cd'.repeat(32), // PLACEHOLDER (nonce lo genera el consumer vía keccak256; chaski re-pinnea el valor real determinístico — ver chaski-v3/contracts/CONTRACT-VERSIONS.md §CD-4). NO copiar verbatim al vendorear.
    },
  },
} as const;
