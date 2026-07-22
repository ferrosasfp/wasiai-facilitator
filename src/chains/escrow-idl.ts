/* eslint-disable no-secrets/no-secrets -- este archivo es una COPIA PINNEADA del IDL Anchor:
   todos los literales base58 (address del programa, token/associated-token/system program ids)
   son pubkeys PÚBLICAS on-chain, no secretos. */
// src/chains/escrow-idl.ts (WKH-216 / HU-SOL-13, Wave 13b)
// COPIA PINNEADA byte-idéntica del IDL del programa escrow Anchor — MISMA fuente inmutable que
// chaski-v3/src/infrastructure/solana/escrow-idl.ts (artefacto de solana-programs, CD-1). Se COPIA,
// NO se edita. SOLO se usa para BorshAccountsCoder(escrowIdl).decode("EscrowState", data) — decodifica
// la CUENTA on-chain (DT-4b/13b), NUNCA valida la tx `release` (eso es CR-1 raw-bytes, CD-12).
// El `address` (BBQ9…79WA) es la ÚNICA fuente del program id. Verificado contra AH-12: cuenta
// EscrowState discriminator [19,90,148,111,55,130,229,108]; layout sender/beneficiary/authority/mint
// (pubkey), amount(u64), deadline(i64), status(enum Deposited|Released|Refunded), bump(u8).
export const escrowIdl = {
  address: 'DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x',
  metadata: {
    name: 'escrow',
    version: '0.1.0',
    spec: '0.1.0',
    description: 'Created with Anchor',
  },
  instructions: [
    {
      name: 'close',
      docs: [
        '`constraint status != Deposited` (AC-8) va en el Context. Aquí solo cerramos el vault.',
      ],
      discriminator: [98, 165, 201, 177, 108, 65, 206, 96],
      accounts: [
        {
          name: 'sender',
          writable: true,
          signer: true,
          relations: ['escrow_state'],
        },
        {
          name: 'mint',
          relations: ['escrow_state'],
        },
        {
          name: 'escrow_state',
          writable: true,
          pda: {
            seeds: [
              { kind: 'const', value: [101, 115, 99, 114, 111, 119] },
              { kind: 'account', path: 'sender' },
              { kind: 'arg', path: 'remittance_id' },
            ],
          },
        },
        {
          name: 'vault',
          writable: true,
          pda: {
            seeds: [
              { kind: 'account', path: 'escrow_state' },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: 'account', path: 'mint' },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'token_program',
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
      ],
      args: [
        {
          name: 'remittance_id',
          type: { array: ['u8', 16] },
        },
      ],
    },
    {
      name: 'deposit',
      discriminator: [242, 35, 198, 137, 82, 225, 242, 182],
      accounts: [
        {
          name: 'sender',
          writable: true,
          signer: true,
        },
        {
          name: 'mint',
        },
        {
          name: 'escrow_state',
          writable: true,
          pda: {
            seeds: [
              { kind: 'const', value: [101, 115, 99, 114, 111, 119] },
              { kind: 'account', path: 'sender' },
              { kind: 'arg', path: 'remittance_id' },
            ],
          },
        },
        {
          name: 'vault',
          writable: true,
          pda: {
            seeds: [
              { kind: 'account', path: 'escrow_state' },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: 'account', path: 'mint' },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'sender_ata',
          writable: true,
        },
        {
          name: 'token_program',
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
        {
          name: 'associated_token_program',
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        },
        {
          name: 'system_program',
          address: '11111111111111111111111111111111',
        },
      ],
      args: [
        {
          name: 'remittance_id',
          type: { array: ['u8', 16] },
        },
        {
          name: 'beneficiary',
          type: 'pubkey',
        },
        {
          name: 'authority',
          type: 'pubkey',
        },
        {
          name: 'amount',
          type: 'u64',
        },
        {
          name: 'deadline',
          type: 'i64',
        },
      ],
    },
    {
      name: 'refund',
      discriminator: [2, 96, 183, 251, 63, 208, 46, 46],
      accounts: [
        {
          name: 'sender',
          writable: true,
          signer: true,
          relations: ['escrow_state'],
        },
        {
          name: 'mint',
          relations: ['escrow_state'],
        },
        {
          name: 'escrow_state',
          writable: true,
          pda: {
            seeds: [
              { kind: 'const', value: [101, 115, 99, 114, 111, 119] },
              { kind: 'account', path: 'sender' },
              { kind: 'arg', path: 'remittance_id' },
            ],
          },
        },
        {
          name: 'vault',
          writable: true,
          pda: {
            seeds: [
              { kind: 'account', path: 'escrow_state' },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: 'account', path: 'mint' },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'sender_ata',
          writable: true,
          pda: {
            seeds: [
              { kind: 'account', path: 'sender' },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: 'account', path: 'mint' },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'token_program',
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
        {
          name: 'associated_token_program',
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        },
      ],
      args: [
        {
          name: 'remittance_id',
          type: { array: ['u8', 16] },
        },
      ],
    },
    {
      name: 'release',
      docs: [
        'Autorización (AC-6) y destino fijo (AC-1) son DECLARATIVOS vía `has_one` en el Context,',
        'no `require!` imperativos. `has_one = authority` -> ConstraintHasOne (2001) si firma otro.',
      ],
      discriminator: [253, 249, 15, 206, 28, 127, 193, 241],
      accounts: [
        {
          name: 'authority',
          signer: true,
          relations: ['escrow_state'],
        },
        {
          name: 'sender',
          relations: ['escrow_state'],
        },
        {
          name: 'beneficiary',
          docs: ['validado por has_one = beneficiary; owner de la ATA destino (CR-4)'],
          relations: ['escrow_state'],
        },
        {
          name: 'mint',
          relations: ['escrow_state'],
        },
        {
          name: 'escrow_state',
          writable: true,
          pda: {
            seeds: [
              { kind: 'const', value: [101, 115, 99, 114, 111, 119] },
              { kind: 'account', path: 'sender' },
              { kind: 'arg', path: 'remittance_id' },
            ],
          },
        },
        {
          name: 'vault',
          writable: true,
          pda: {
            seeds: [
              { kind: 'account', path: 'escrow_state' },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: 'account', path: 'mint' },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'beneficiary_ata',
          writable: true,
          pda: {
            seeds: [
              { kind: 'account', path: 'beneficiary' },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: 'account', path: 'mint' },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'token_program',
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
        {
          name: 'associated_token_program',
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        },
      ],
      args: [
        {
          name: 'remittance_id',
          type: { array: ['u8', 16] },
        },
      ],
    },
  ],
  accounts: [
    {
      name: 'EscrowState',
      discriminator: [19, 90, 148, 111, 55, 130, 229, 108],
    },
  ],
  errors: [
    { code: 6000, name: 'ZeroAmount', msg: 'Deposit amount must be greater than zero' },
    { code: 6001, name: 'InvalidDeadline', msg: 'Deadline must be in the future' },
    { code: 6002, name: 'EscrowNotDeposited', msg: 'Escrow is not in the Deposited state' },
    { code: 6003, name: 'DeadlineNotReached', msg: 'Deadline has not been reached yet' },
    { code: 6004, name: 'EscrowNotTerminal', msg: 'Escrow must be in a terminal state to close' },
  ],
  types: [
    {
      name: 'EscrowState',
      type: {
        kind: 'struct',
        fields: [
          { name: 'sender', type: 'pubkey' },
          { name: 'beneficiary', type: 'pubkey' },
          { name: 'authority', type: 'pubkey' },
          { name: 'mint', type: 'pubkey' },
          { name: 'amount', type: 'u64' },
          { name: 'deadline', type: 'i64' },
          { name: 'status', type: { defined: { name: 'EscrowStatus' } } },
          { name: 'bump', type: 'u8' },
        ],
      },
    },
    {
      name: 'EscrowStatus',
      type: {
        kind: 'enum',
        variants: [{ name: 'Deposited' }, { name: 'Released' }, { name: 'Refunded' }],
      },
    },
  ],
} as const;
