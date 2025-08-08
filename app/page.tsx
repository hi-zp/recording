import { redirect } from 'next/navigation';
import RTCClient from './components/RTCClient';

export default async function Page({ searchParams }: { searchParams?: Promise<{ room?: string | string[] }> }) {
  const params = (await (searchParams ?? Promise.resolve({} as any))) as any;
  let room: string | undefined = params?.room;
  if (Array.isArray(room)) room = room[0];
  if (!room) {
    const newRoom = Math.floor(Math.random() * 0xFFFFFF).toString(16);
    redirect(`/?room=${newRoom}`);
  }
  return <RTCClient room={room!} />;
}

