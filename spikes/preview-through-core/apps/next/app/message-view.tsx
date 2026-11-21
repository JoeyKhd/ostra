"use client";

import { message } from "./message";

// A client component, so an edit to message.ts is a Fast Refresh update over the HMR socket.
export const Message = () => <h1 id="message">{message}</h1>;
