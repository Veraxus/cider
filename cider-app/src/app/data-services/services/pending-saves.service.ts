import { Injectable } from '@angular/core';

/**
 * Editors debounce their saves. They register a flush callback here so that saving the
 * project, reloading it, or leaving the editor writes their latest edits to the database first.
 */
@Injectable({
  providedIn: 'root'
})
export class PendingSavesService {
  private flushCallbacks = new Set<() => Promise<unknown>>();
  private inFlight = new Set<Promise<unknown>>();

  /**
   * Register an editor's flush callback
   *
   * @returns a function that unregisters the callback
   */
  public register(flush: () => Promise<unknown>): () => void {
    this.flushCallbacks.add(flush);
    return () => this.flushCallbacks.delete(flush);
  }

  /**
   * Track a save that is still being written, such as one started when an editor closes
   */
  public track(save: Promise<unknown>) {
    const tracked: Promise<unknown> = save
      .catch(error => console.error('Error saving pending edits', error))
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /**
   * Write the pending edits of every editor and wait until they are saved
   */
  public async flushAll(): Promise<void> {
    this.flushCallbacks.forEach(flush => this.track(flush()));
    await Promise.all(Array.from(this.inFlight));
  }
}
