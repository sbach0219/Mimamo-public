import { monitorServerDelivery } from '../serverDelivery';

describe('monitorServerDelivery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const callbacks = () => ({
    onSending: jest.fn(),
    onDelivered: jest.fn(),
    onUnconfirmed: jest.fn(),
    onFailed: jest.fn(),
  });

  it('marks delivery after the server accepts the write', async () => {
    const c = callbacks();
    monitorServerDelivery(Promise.resolve(), c, 100);
    await Promise.resolve();

    expect(c.onSending).toHaveBeenCalledTimes(1);
    expect(c.onDelivered).toHaveBeenCalledTimes(1);
    expect(c.onUnconfirmed).not.toHaveBeenCalled();
  });

  it('shows unconfirmed first, then delivery after a delayed acknowledgement', async () => {
    let resolve!: () => void;
    const write = new Promise<void>((r) => { resolve = r; });
    const c = callbacks();
    monitorServerDelivery(write, c, 100);

    jest.advanceTimersByTime(100);
    expect(c.onUnconfirmed).toHaveBeenCalledTimes(1);

    resolve();
    await Promise.resolve();
    expect(c.onDelivered).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected write as failed', async () => {
    const c = callbacks();
    monitorServerDelivery(Promise.reject(new Error('permission-denied')), c, 100);
    await Promise.resolve();
    await Promise.resolve();

    expect(c.onFailed).toHaveBeenCalledTimes(1);
    expect(c.onUnconfirmed).not.toHaveBeenCalled();
  });
});
