import { redirect } from 'next/navigation';
import RTCClient from './components/RTCClient';

export default function Page({ searchParams }: { searchParams?: { room?: string } }) {
  const room = searchParams?.room;
  if (!room) {
    const newRoom = Math.floor(Math.random() * 0xFFFFFF).toString(16);
    redirect(`/?room=${newRoom}`);
  }
  return <RTCClient room={room!} />;
}

