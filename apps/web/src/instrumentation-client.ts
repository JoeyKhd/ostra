import { listenForTraversals } from "@/lib/leave-guard";

// Next runs this before any of the panel's React code. The leave guard's Back and Forward listener
// is added here, ahead of the app router's own, so a page that holds something it can't show again
// (F-006/c4: Turn on's webhook secret) asks before Back or Forward leaves it.
listenForTraversals();
