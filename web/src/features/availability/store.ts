import { type Availability, availabilitySchema, normalizeSlots, type Slot } from '@vrp/shared';
import { deleteDoc, doc, setDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';

/** 稼働時間帯の上書きの保存と、基本へのもどし（ADR-0008。書ける範囲は firestore.rules が決める） */

export const availabilityId = (staffId: string, date: string) => `${staffId}_${date}`;

export async function saveAvailability(
  orgId: string,
  input: { staffId: string; date: string; slots: Slot[]; byStaff: boolean; uid: string },
): Promise<void> {
  const data: Availability = availabilitySchema.parse({
    staffId: input.staffId,
    date: input.date,
    slots: normalizeSlots(input.slots),
    byStaff: input.byStaff,
    updatedBy: input.uid,
    updatedAt: Date.now(),
  });
  await setDoc(doc(db, 'orgs', orgId, 'availability', availabilityId(input.staffId, input.date)), data);
}

export async function resetAvailability(orgId: string, staffId: string, date: string): Promise<void> {
  await deleteDoc(doc(db, 'orgs', orgId, 'availability', availabilityId(staffId, date)));
}
