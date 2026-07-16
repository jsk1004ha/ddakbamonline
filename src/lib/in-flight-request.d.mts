export interface InFlightRequestCoordinator {
  run(scope: string, request: () => Promise<void>): Promise<void>;
}

export function createInFlightRequestCoordinator(): InFlightRequestCoordinator;
