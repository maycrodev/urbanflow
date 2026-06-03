import { SignalCommand } from '@urbanflow/shared';

/**
 * Codificación NTCIP simplificada para el sistema de semáforos legado.
 *
 * Restricción del contexto: el sistema tiene 20 años, habla NTCIP sobre 4G
 * privada y SOLO acepta mensajes de MÁXIMO 256 bytes. Codificamos la petición
 * de prioridad en una trama TLV compacta y validamos el límite de tamaño.
 *
 * Formato de trama:
 *   [0]      STX (0x02)
 *   [1]      msgType (0x10 = SIGNAL_PRIORITY_REQUEST)
 *   [2]      priorityFor (0x01=DELAYED_BUS, 0x02=EMERGENCY_VEHICLE)
 *   [3]      approach (0x4E='N',0x53='S',0x45='E',0x57='W')
 *   [4..5]   greenExtensionSec (uint16 BE)
 *   [6]      intersectionId len (L1)
 *   [7..]    intersectionId (ascii)
 *   [.]      vehicleId len (L2)
 *   [.]      vehicleId (ascii)
 *   [last]   checksum (XOR de todos los bytes previos)
 */
export const NTCIP_MAX_BYTES = 256;
const STX = 0x02;
const MSG_PRIORITY = 0x10;

export class NtcipFrameTooLargeError extends Error {
  constructor(size: number) {
    super(`Trama NTCIP de ${size} bytes excede el máximo de ${NTCIP_MAX_BYTES} bytes`);
  }
}

export function encodeNtcip(cmd: SignalCommand): Buffer {
  const head = Buffer.alloc(6);
  head[0] = STX;
  head[1] = MSG_PRIORITY;
  head[2] = cmd.priorityFor === 'EMERGENCY_VEHICLE' ? 0x02 : 0x01;
  head[3] = cmd.approach.charCodeAt(0);
  head.writeUInt16BE(Math.min(cmd.greenExtensionSec, 0xffff), 4);

  const inter = Buffer.from(cmd.intersectionId.slice(0, 64), 'ascii');
  const veh = Buffer.from(cmd.vehicleId.slice(0, 64), 'ascii');
  const body = Buffer.concat([
    Buffer.from([inter.length]),
    inter,
    Buffer.from([veh.length]),
    veh,
  ]);

  const withoutChecksum = Buffer.concat([head, body]);
  const checksum = withoutChecksum.reduce((acc, b) => acc ^ b, 0);
  const frame = Buffer.concat([withoutChecksum, Buffer.from([checksum])]);

  if (frame.length > NTCIP_MAX_BYTES) throw new NtcipFrameTooLargeError(frame.length);
  return frame;
}

export function decodeNtcip(frame: Buffer): { msgType: number; priorityFor: number; intersectionId: string; vehicleId: string } {
  let off = 6;
  const interLen = frame[off++];
  const intersectionId = frame.subarray(off, off + interLen).toString('ascii');
  off += interLen;
  const vehLen = frame[off++];
  const vehicleId = frame.subarray(off, off + vehLen).toString('ascii');
  return { msgType: frame[1], priorityFor: frame[2], intersectionId, vehicleId };
}
