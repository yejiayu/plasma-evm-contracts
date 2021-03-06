const { range, last, first } = require('lodash');
const expectEvent = require('openzeppelin-solidity/test/helpers/expectEvent');
const { increaseTime } = require('openzeppelin-solidity/test/helpers/increaseTime');

const { padLeft } = require('./helpers/pad');
const { appendHex } = require('./helpers/appendHex');
const Data = require('./lib/Data');

const RootChain = artifacts.require('RootChain.sol');
const RequestableSimpleToken = artifacts.require('RequestableSimpleToken.sol');

require('chai')
  .use(require('chai-bignumber')(web3.BigNumber))
  .should();

const BigNumber = web3.BigNumber;
const LOGTX = process.env.LOGTX || false;
const VERBOSE = process.env.VERBOSE || false;

const etherAmount = new BigNumber(10e18);
const tokenAmount = new BigNumber(10e18);
const exitAmount = tokenAmount.div(1000);
const emptyBytes32 = 0;

// genesis block merkle roots
const statesRoot = '0x0ded2f89db1e11454ba4ba90e31850587943ed4a412f2ddf422bd948eae8b164';
const transactionsRoot = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const receiptsRoot = '0x000000000000000000000000000000000000000000000000000000000000dead';

// eslint-disable-next-line max-len
const failedReceipt = '0xf9010800825208b9010000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c0';
const dummyProof = '0x00';

contract('RootChain', async ([
  operator,
  ...others
]) => {
  let rootchain;
  let token;
  const tokenInChildChain = '0x000000000000000000000000000000000000dead';

  // account parameters
  others = others.slice(0, 4);
  const submiter = others[0]; // URB submiter

  // rootchain parameters
  let MAX_REQUESTS;
  let NRELength; // === 2
  let COST_ERO, COST_ERU, COST_URB_PREPARE, COST_URB, COST_ORB, COST_NRB;
  let CP_COMPUTATION, CP_WITHHOLDING;

  // test variables
  let currentFork = 0;

  let numEROs = 0;
  const numERUs = 0;

  let requestIdToApply = 0;
  const forks = [];
  forks.push({
    firstBlock: 0,
    lastBlock: 0,
    firstEpoch: 0,
    lastEpoch: 0,
    lastFinalizedBlock: 0,
    forkedBlock: 0,
  });

  async function newFork () {
    await timeout(1);
    const lastFinalizedBlock = last(forks).lastFinalizedBlock;

    const firstBlock = lastFinalizedBlock + 1;
    const firstEpoch = new Data.PlasmaBlock(
      await rootchain.getBlock(currentFork, firstBlock)
    ).epochNumber.toNumber();

    currentFork += 1;
    forks.push({
      firstBlock: firstBlock,
      lastBlock: 0,
      firstEpoch: firstEpoch,
      lastEpoch: firstEpoch,
      lastFinalizedBlock: lastFinalizedBlock,
    });
    forks[currentFork - 1].forkedBlock = firstBlock;

    log(`[Added fork]: ${JSON.stringify(last(forks))}`);
  }

  before(async () => {
    rootchain = await RootChain.deployed();
    token = await RequestableSimpleToken.new();

    await Promise.all(others.map(other => token.mint(other, tokenAmount.mul(100))));
    await rootchain.mapRequestableContractByOperator(token.address, tokenInChildChain);
    (await rootchain.requestableContracts(token.address)).should.be.equal(tokenInChildChain);

    // read parameters
    MAX_REQUESTS = await rootchain.MAX_REQUESTS();
    NRELength = await rootchain.NRELength();
    COST_ERO = await rootchain.COST_ERO();
    COST_ERU = await rootchain.COST_ERU();
    COST_URB_PREPARE = await rootchain.COST_URB_PREPARE();
    COST_URB = await rootchain.COST_URB();
    COST_ORB = await rootchain.COST_ORB();
    COST_NRB = await rootchain.COST_NRB();
    CP_COMPUTATION = (await rootchain.CP_COMPUTATION()).toNumber();
    CP_WITHHOLDING = (await rootchain.CP_WITHHOLDING()).toNumber();

    log(`
      EpochHandler contract at ${await rootchain.epochHandler()}
      RootChain contract at ${rootchain.address}
      `);

    const targetEvents = [
      'BlockSubmitted',
      'EpochPrepared',
      'BlockFinalized',
      'EpochFinalized',
      'EpochRebased',
      'RequestCreated',
      'RequestFinalized',
      'RequestChallenged',
      'Forked',
    ];

    const eventHandlers = {
      // 'BlockFinalized': (e) => {
      //   const forkNumber = e.args.forkNumber.toNumber();
      //   const blockNumber = e.args.blockNumber.toNumber();
      //   forks[forkNumber].lastFinalizedBlock = blockNumber;
      // },
      // 'EpochFinalized': (e) => {
      //   const forkNumber = e.args.forkNumber.toNumber();
      //   const endBlockNumber = e.args.endBlockNumber.toNumber();
      //   forks[forkNumber].lastFinalizedBlock = endBlockNumber;
      // },
    };

    for (const eventName of targetEvents) {
      const event = rootchain[eventName]({});
      event.watch((err, e) => {
        if (!err) {
          log(`[${eventName}]: ${JSON.stringify(e.args)}`);
          if (typeof eventHandlers[eventName] === 'function') {
            eventHandlers[eventName](e);
          }
        } else {
          console.error(`[${eventName}]`, err);
        }
      });
    }
  });

  // Chain is fored after a URB is submitted.
  async function checkFork () {
    await timeout(1);
    const previousFork = currentFork - 1;

    const preFork = new Data.Fork(await rootchain.forks(previousFork));
    const curFork = new Data.Fork(await rootchain.forks(currentFork));

    preFork.forkedBlock.should.be.bignumber.equal(curFork.firstBlock);

    const lastFinalizedBlock = new Data.PlasmaBlock(
      await rootchain.getBlock(previousFork, curFork.firstBlock.sub(1))
    );

    lastFinalizedBlock.finalized.should.be.equal(true);

    const nextBlock = new Data.PlasmaBlock(
      await rootchain.getBlock(previousFork, curFork.firstBlock)
    );

    (nextBlock.timestamp.toNumber() === 0 || !nextBlock.finalized)
      .should.be.equal(true);

    const firstURB = new Data.PlasmaBlock(
      await rootchain.getBlock(currentFork, curFork.firstBlock)
    );

    const URE = new Data.Epoch(
      await rootchain.getEpoch(currentFork, firstURB.epochNumber)
    );

    URE.isEmpty.should.be.equal(false);
    URE.isRequest.should.be.equal(true);
    URE.userActivated.should.be.equal(true);
  }

  // check ORE, NRE, URE, ORE' and NRE'.
  async function checkEpoch (epochNumber) {
    const fork = new Data.Fork(await rootchain.forks(currentFork));
    const epoch = new Data.Epoch(await rootchain.getEpoch(currentFork, epochNumber));
    const numBlocks = epoch.requestEnd.sub(epoch.requestStart).add(1).div(MAX_REQUESTS).ceil();

    // TODO: check block is included in the epoch

    log(`
    checking Epoch#${currentFork}#${epochNumber}`);

    // check # of blocks
    if (epoch.isRequest && !epoch.rebase) {
      log(`epoch1: ${JSON.stringify(epoch)}`);
      const expectedNumBlocks = epoch.endBlockNumber.sub(epoch.startBlockNumber).add(1);
      expectedNumBlocks.should.be.bignumber.equal(numBlocks);
    }

    if (epochNumber === 1) { // first NRB epoch
      epoch.startBlockNumber.should.be.bignumber.equal(1);
      epoch.endBlockNumber.should.be.bignumber.equal(NRELength);
      epoch.isRequest.should.be.equal(false);
      epoch.isEmpty.should.be.equal(false);
    } else if (epochNumber === 2) { // second ORB epoch
      if (epoch.isEmpty) {
        epoch.startBlockNumber.should.be.bignumber.equal(NRELength);
        epoch.endBlockNumber.should.be.bignumber.equal(epoch.startBlockNumber);
      } else {
        epoch.startBlockNumber.should.be.bignumber.equal(NRELength.add(1));
      }
      epoch.isRequest.should.be.equal(true);
    } else if (epochNumber > 2 && epoch.isRequest && epoch.userActivated) {
      // TODO: check URE

    } else if (epochNumber > 2 && epoch.isRequest) { // later request epochs
      if (!epoch.rebase) {
        // check ORE

        // previous non request epoch
        const previousNRE = new Data.Epoch(await rootchain.getEpoch(currentFork, epochNumber - 1));

        // previous request epoch
        const previousORENumber = currentFork !== 0 && fork.firstEpoch.add(4).eq(epochNumber)
          ? epochNumber - 3 : epochNumber - 2;
        const previousORE = new Data.Epoch(await rootchain.getEpoch(currentFork, previousORENumber));
        const numPreviousORBs = previousORE.endBlockNumber.sub(previousORE.startBlockNumber).add(1);

        const firstRequestBlockNumber = await rootchain.firstFilledORENumber(currentFork);

        log(`
        Epoch?
         - last: ${epochNumber}
         - previous requeast epoch: ${previousORENumber}
         - firstRequestBlockNumber: ${firstRequestBlockNumber}
        `);

        previousORE.isRequest.should.be.equal(true);

        if (epoch.isEmpty) {
          epoch.startBlockNumber.should.be.bignumber.equal(previousNRE.endBlockNumber);
          epoch.endBlockNumber.should.be.bignumber.equal(epoch.startBlockNumber);

          epoch.requestStart.should.be.bignumber.equal(previousORE.requestEnd);
          epoch.requestStart.should.be.bignumber.equal(epoch.requestEnd);

          epoch.firstRequestBlockId.should.be.bignumber.equal(previousORE.firstRequestBlockId);
        } else {
          epoch.startBlockNumber.should.be.bignumber.equal(previousNRE.endBlockNumber.add(1));
          epoch.requestEnd.should.be.bignumber.gt(epoch.requestStart);

          if (currentFork === 0 && firstRequestBlockNumber.cmp(epochNumber) === 0) {
            // first ORE
            epoch.requestStart.should.be.bignumber.equal(0);
            epoch.firstRequestBlockId.should.be.bignumber.equal(0);
          } else if (firstRequestBlockNumber.cmp(epochNumber) === 0) {
            epoch.requestStart.should.be.bignumber.equal(previousORE.requestEnd.add(1));
            epoch.firstRequestBlockId.should.be.bignumber.equal(previousORE.firstRequestBlockId.add(numPreviousORBs));
          } else {
            epoch.requestStart.should.be.bignumber.equal(previousORE.requestEnd.add(1));
            epoch.firstRequestBlockId.should.be.bignumber.equal(previousORE.firstRequestBlockId.add(numPreviousORBs));
          }
        }
      } else {
        // check ORE'

        // previous URE
        const previousURE = new Data.Epoch(await rootchain.getEpoch(currentFork, epochNumber - 1));
        previousURE.userActivated.should.be.equal(true);
        previousURE.isRequest.should.be.equal(true);

        if (!epoch.endBlockNumber.eq(0) && !epoch.isEmpty) {
          const numBlocks = epoch.endBlockNumber.sub(epoch.startBlockNumber).add(1);
          numBlocks.should.be.bignumber.gt(0);
        }
      }
    } else if (epochNumber > 2 && !epoch.isRequest) { // later non request epochs
      // check NRE
      if (!epoch.rebase) {
        // previous request epoch
        const previousORE = new Data.Epoch(await rootchain.getEpoch(currentFork, epochNumber - 1));

        epoch.startBlockNumber.should.be.bignumber.equal(previousORE.endBlockNumber.add(1));
        epoch.endBlockNumber.sub(epoch.startBlockNumber).add(1).should.be.bignumber.equal(NRELength);

        epoch.isRequest.should.be.equal(false);
        epoch.isEmpty.should.be.equal(false);
      } else {
        // check NRE'

        // previous NRE'
        const previousNREAfterFork = new Data.Epoch(await rootchain.getEpoch(currentFork, epochNumber - 1));
        previousNREAfterFork.userActivated.should.be.equal(false);
        previousNREAfterFork.isRequest.should.be.equal(true);

        // TODO: check num blocks in NRE'
        if (!epoch.endBlockNumber.eq(0) && !epoch.isEmpty) {
          const numBlocks = epoch.endBlockNumber.sub(epoch.startBlockNumber).add(1);
          numBlocks.should.be.bignumber.gt(0);
        }

        // // check fork
        // const fork = new Data.Fork(await rootchain.forks(currentFork));
        // fork.rebased.should.be.equal(true);
      }
    }
  }

  async function checkRequestBlock (blockNumber) {
    const forkNumber = currentFork;
    const fork = forks[forkNumber];

    const block = new Data.PlasmaBlock(await rootchain.getBlock(forkNumber, blockNumber));
    const epoch = new Data.Epoch(await rootchain.getEpoch(forkNumber, block.epochNumber));
    const requestBlock = new Data.RequestBlock(await rootchain.ORBs(block.requestBlockId));

    let perviousEpochNumber = block.epochNumber.sub(2);
    let perviousEpoch = new Data.Epoch(await rootchain.getEpoch(forkNumber, perviousEpochNumber));

    // in case of first ORE after forked (not ORE')
    if (forkNumber !== 0 && block.epochNumber.cmp(fork.firstEpoch + 4) === 0) {
      perviousEpochNumber = block.epochNumber.sub(3);
      perviousEpoch = new Data.Epoch(await rootchain.getEpoch(forkNumber, perviousEpochNumber));
    }

    if (!epoch.rebase) {
      await logEpoch(forkNumber, perviousEpochNumber);
    }

    await logEpoch(forkNumber, block.epochNumber);
    await logBlock(forkNumber, blockNumber);
    log(`      RequestBlock#${block.requestBlockId} ${JSON.stringify(requestBlock)}`);

    block.isRequest.should.be.equal(true);
    epoch.isRequest.should.be.equal(true);
    epoch.isEmpty.should.be.equal(false);

    // check epochs
    if (!epoch.rebase) {
      // check ORE
      perviousEpoch.initialized.should.be.equal(true);
      perviousEpoch.isRequest.should.be.equal(true);

      if (perviousEpoch.isEmpty) {
        if (perviousEpoch.rebase) {
          epoch.firstRequestBlockId.should.be.bignumber.equal(perviousEpoch.firstRequestBlockId.add(1));
        } else {
          epoch.firstRequestBlockId.should.be.bignumber.equal(perviousEpoch.firstRequestBlockId);
        }
      } else if (perviousEpoch.initialized) {
        // previous request epoch is not empty
        const numPreviousBlocks = perviousEpoch.endBlockNumber.sub(perviousEpoch.startBlockNumber).add(1);
        const expectedFirstRequestBlockId = perviousEpoch.firstRequestBlockId.add(numPreviousBlocks);

        epoch.firstRequestBlockId.should.be.bignumber.equal(expectedFirstRequestBlockId);
      } else {
        // this epoch is the first request epoch
        (await rootchain.firstFilledORENumber(forkNumber)).should.be.bignumber.equal(epochNumber);
      }
    } else {
      // check ORE'
      // check only if ORE' is filled
      if (epoch.endBlockNumber.cmp(0) !== 0) {
        const previousForkNumber = forkNumber - 1;
        const previousFork = forks[previousForkNumber];
        const forkedBlock = new Data.PlasmaBlock(await rootchain.getBlock(previousForkNumber, previousFork.forkedBlock));

        const previousEpochNumbers = range(forkedBlock.epochNumber, previousFork.lastEpoch + 1);
        const previousEpochs = (await Promise.all(previousEpochNumbers
          .map(epochNumber => rootchain.getEpoch(previousForkNumber, epochNumber))))
          .map(e => new Data.Epoch(e));

        const previousRequestEpochs = [];
        const proms = [];
        for (const i of range(previousEpochs.length)) {
          const e = previousEpochs[i];
          if (e.isRequest && !e.isEmpty) {
            const n = previousEpochNumbers[i];

            proms.push(logEpoch(previousForkNumber, n));
            previousRequestEpochs.push({ epochNumber: n, epoch: e });
          }
        }

        // log all previous request epochs
        await proms;
        const noRequestEpoch = previousRequestEpochs.length === 0;
        noRequestEpoch.should.be.equal(false);

        const firstRequestEpochAfterFork = first(previousRequestEpochs).epoch;
        const lastRequestEpochAfterFork = last(previousRequestEpochs).epoch;

        epoch.requestStart.should.be.bignumber.equal(firstRequestEpochAfterFork.requestStart);
        epoch.requestEnd.should.be.bignumber.equal(lastRequestEpochAfterFork.requestEnd);

        // test previous block and referenceBlock
        let currentBlockNumber = Number(blockNumber);
        for (const e of previousRequestEpochs) {
          const referenceEpoch = e.epoch;
          for (const referenceBlockNumber of range(
            referenceEpoch.startBlockNumber.toNumber(), referenceEpoch.endBlockNumber.toNumber())) {
            const referenceBlock = new Data.PlasmaBlock(await rootchain.getBlock(previousForkNumber, referenceBlockNumber));
            const currentBlock = new Data.PlasmaBlock(await rootchain.getBlock(currentFork, currentBlockNumber));
            currentBlock.referenceBlock.should.be.bignumber.equal(referenceBlockNumber);
            currentBlock.requestBlockId.should.be.bignumber.equal(referenceBlock.requestBlockId);

            currentBlockNumber += 1;
          }
        }
      }
    }

    // check request block
    const numBlocks = epoch.endBlockNumber.sub(epoch.startBlockNumber).add(1);
    block.requestBlockId.should.be.bignumber.gte(epoch.firstRequestBlockId);
    block.requestBlockId.should.be.bignumber.lt(epoch.firstRequestBlockId.add(numBlocks));

    epoch.requestStart.should.be.bignumber.lte(requestBlock.requestStart);
    epoch.requestEnd.should.be.bignumber.gte(requestBlock.requestEnd);
  }

  async function checkLastBlockNumber () {
    (await rootchain.lastBlock(currentFork))
      .should.be.bignumber.equal(forks[currentFork].lastBlock);
  }

  async function checkLastEpoch (isRequest, userActivated, rebase = false) {
    const epoch = new Data.Epoch(await rootchain.getLastEpoch());

    epoch.isRequest.should.be.equal(isRequest);
    epoch.userActivated.should.be.equal(userActivated);
    epoch.rebase.should.be.equal(rebase);
  }

  async function checkLastEpochNumber () {
    (await rootchain.lastEpoch(currentFork))
      .should.be.bignumber.equal(forks[currentFork].lastEpoch);
  }

  async function submitDummyNRBs (numBlocks) {
    for (const _ of range(numBlocks)) {
      await checkLastBlockNumber();

      const tx = await rootchain.submitNRB(currentFork, statesRoot, transactionsRoot, receiptsRoot, { value: COST_NRB });
      logtx(tx);
      forks[currentFork].lastBlock += 1;

      await checkLastBlockNumber();
    }
  }

  async function submitDummyORBs (numBlocks) {
    for (const _ of range(numBlocks)) {
      await checkLastBlockNumber();

      const tx = await rootchain.submitORB(currentFork, statesRoot, transactionsRoot, receiptsRoot, { value: COST_ORB });
      logtx(tx);
      forks[currentFork].lastBlock += 1;

      await checkRequestBlock(forks[currentFork].lastBlock);
      await checkLastBlockNumber();
    }
  }

  async function submitDummyURBs (numBlocks, firstURB = true) {
    for (const _ of range(numBlocks)) {
      const tx = await rootchain.submitURB(currentFork, statesRoot, transactionsRoot, receiptsRoot,
        { from: submiter, value: COST_URB });
      logtx(tx);

      if (firstURB) {
        // consume events
        await timeout(3);

        forks[currentFork].lastBlock = forks[currentFork - 1].lastFinalizedBlock + 1;
      } else {
        forks[currentFork].lastBlock += 1;
      }

      firstURB = false;

      await checkLastBlockNumber();
    }
  }

  async function finalizeBlocks () {
    // finalize blocks until all blocks are fianlized
    const lastFinalizedBlock1 = await rootchain.getLastFinalizedBlock(currentFork);

    // short circuit if all blocks are finalized
    if (lastFinalizedBlock1.gte(forks[currentFork].lastBlock)) {
      return;
    }

    log(`
      lastBlock: ${forks[currentFork].lastBlock}
      lastFinalizedBlock: ${lastFinalizedBlock1}
    `);

    await increaseTime(CP_WITHHOLDING + 1);
    await rootchain.finalizeBlock();

    const lastFinalizedBlock2 = await rootchain.getLastFinalizedBlock(currentFork);
    forks[currentFork].lastFinalizedBlock = lastFinalizedBlock2.toNumber();

    return finalizeBlocks();
  }

  async function applyRequests (invalid = false) {
    await finalizeBlocks();

    for (const requestId of range(requestIdToApply, numEROs)) {
      const request1 = new Data.Request(await rootchain.EROs(requestId));

      request1.finalized.should.be.equal(false);

      const etherAmount1 = await web3.eth.getBalance(request1.to);
      const tokenBalance1 = await token.balances(request1.requestor);

      const tx = await rootchain.applyRequest();
      const e = await expectEvent.inTransaction(tx, 'RequestFinalized');

      const request2 = new Data.Request(await rootchain.EROs(requestId));

      log(`
      requestIdToApply:${requestIdToApply}
      e.args.requestId.toNumber():${e.args.requestId.toNumber()}
      `);

      request2.finalized.should.be.equal(true);

      const etherAmount2 = await web3.eth.getBalance(request1.to);
      const tokenBalance2 = await token.balances(request2.requestor);

      if (request1.isExit && !invalid) {
        tokenBalance2.should.be.bignumber
          .equal(tokenBalance1.add(parseInt(request1.trieValue, 16)));
      } else if (invalid) {
        request2.challenged.should.be.equal(true);
        tokenBalance2.should.be.bignumber.equal(tokenBalance1);
      }
      requestIdToApply = e.args.requestId.toNumber() + 1;
    }
  }

  async function logEpoch (forkNumber, epochNumber) {
    if (epochNumber < 0) return;

    const epoch = new Data.Epoch(await rootchain.getEpoch(forkNumber, epochNumber));
    log(`      Epoch#${forkNumber}.${epochNumber} ${JSON.stringify(epoch)}`);
  }

  async function logBlock (forkNumber, blockNumber) {
    const block = new Data.PlasmaBlock(await rootchain.getBlock(forkNumber, blockNumber));
    log(`      Block#${blockNumber} ${JSON.stringify(block)}`);
  }

  async function logEpochAndBlock (forkNumber, epochNumber) {
    const epoch = new Data.Epoch(await rootchain.getEpoch(forkNumber, epochNumber));
    log(`
      Epoch#${forkNumber}.${epochNumber} ${JSON.stringify(epoch)}
      ORBs.length: ${await rootchain.getNumORBs()}
      `);

    for (const i of range(
      epoch.startBlockNumber.toNumber(),
      epoch.endBlockNumber.toNumber() + 1
    )) {
      log(`
        Block#${i} ${JSON.stringify(new Data.PlasmaBlock(await rootchain.getBlock(forkNumber, i)))}`);
    }
  }

  const testEpochsWithoutRequest = (NRBEPochNumber) => {
    const ORBEPochNumber = NRBEPochNumber + 1;

    before(`check NRE#${NRBEPochNumber} parameters`, async () => {
      await logEpoch(currentFork, NRBEPochNumber - 2);
      await logEpoch(currentFork, NRBEPochNumber - 1);
      await logEpoch(currentFork, NRBEPochNumber);

      const fork = forks[currentFork];
      const rebase = currentFork !== 0 && fork.firstEpoch + 2 === fork.lastEpoch;
      const isRequest = NRBEPochNumber !== 1 && !rebase;
      const userActivated = false;

      log(`
      [testEpochsWithoutRequest]
      NRBEPochNumber: ${NRBEPochNumber}
      forks[currentFork].lastEpoch: ${forks[currentFork].lastEpoch}
      rootchain.forks: ${JSON.stringify(new Data.Fork(await rootchain.forks(currentFork)))}
      rootchain.lastEpoch: ${JSON.stringify(new Data.Epoch(await rootchain.getLastEpoch()))}
      `);

      await checkLastBlockNumber();
      await checkLastEpochNumber();
      await checkLastEpoch(isRequest, userActivated, rebase);

      await logEpochAndBlock(currentFork, forks[currentFork].lastEpoch);
      await checkEpoch(forks[currentFork].lastEpoch);
    });

    it(`next empty ORE#${ORBEPochNumber} should be prepared`, async () => {
      // submits `NRELength` NRBs
      await submitDummyNRBs(NRELength);

      await logEpochAndBlock(currentFork, forks[currentFork].lastEpoch + 1);
      await logEpochAndBlock(currentFork, forks[currentFork].lastEpoch + 2);

      // because no ERO, ORB epoch is empty
      const isRequest = true;
      const userActivated = false;

      forks[currentFork].lastEpoch += 2;
      await checkEpoch(forks[currentFork].lastEpoch - 1);
      await checkEpoch(forks[currentFork].lastEpoch);

      await checkLastEpoch(isRequest, userActivated);
      await checkLastEpochNumber();
    });

    it('can finalize blocks', finalizeBlocks);
  };

  const testEpochsWithRequest = (NRBEPochNumber) => {
    const ORBEPochNumber = NRBEPochNumber + 1;

    before(`check NRE#${NRBEPochNumber} parameters`, async () => {
      await logEpoch(currentFork, NRBEPochNumber - 2);
      await logEpoch(currentFork, NRBEPochNumber - 1);
      await logEpoch(currentFork, NRBEPochNumber);

      const fork = forks[currentFork];
      const rebase = currentFork !== 0 && fork.firstEpoch + 2 === fork.lastEpoch;
      const isRequest = NRBEPochNumber !== 1 && !rebase;
      const userActivated = false;

      await checkEpoch(forks[currentFork].lastEpoch);
      await checkLastEpoch(isRequest, userActivated);

      await checkLastBlockNumber();
      await checkLastEpochNumber();
    });

    it(`NRE#${NRBEPochNumber}: user can make an enter request for ether deposit`, async () => {
      const isTransfer = true;

      (await rootchain.getNumEROs()).should.be.bignumber.equal(numEROs);
      const numORBs = await rootchain.getNumORBs();

      const txs = await Promise.all(others.map(async other => {
        const tx = await rootchain.startEnter(isTransfer, other, emptyBytes32, emptyBytes32, {
          from: other,
          value: etherAmount,
        });
        logtx(tx);

        const requestId = tx.logs[0].args.requestId;
        const requestTxRLPBytes = await rootchain.getEROBytes(requestId);

        // TODO: check the RLP encoded bytes
        requestTxRLPBytes.slice(2, 4).toLowerCase().should.be.equal('ec');

        return tx;
      }));

      (await rootchain.getNumORBs()).should.be.bignumber.equal(numORBs.add(1));

      numEROs += others.length;

      (await rootchain.getNumEROs()).should.be.bignumber.equal(numEROs);
    });

    it(`NRE#${NRBEPochNumber}: user can make an enter request for token deposit`, async () => {
      const isTransfer = false;

      (await rootchain.getNumEROs()).should.be.bignumber.equal(numEROs);
      const numORBs = await rootchain.getNumORBs();

      await Promise.all(others.map(async other => {
        const trieKey = calcTrieKey(other);
        const trieValue = padLeft(web3.fromDecimal(tokenAmount));

        (await token.getBalanceTrieKey(other)).should.be.equals(trieKey);

        const tokenBalance1 = await token.balances(other);
        const tx = await rootchain.startEnter(isTransfer, token.address, trieKey, trieValue, { from: other });
        logtx(tx);

        (await token.balances(other)).should.be.bignumber.equal(tokenBalance1.sub(tokenAmount));
      }));

      numEROs += others.length;

      (await rootchain.getNumEROs()).should.be.bignumber.equal(numEROs);
    });

    it(`NRE#${NRBEPochNumber}: operator submits NRBs`, async () => {
      await submitDummyNRBs(NRELength);
      await logEpochAndBlock(currentFork, forks[currentFork].lastEpoch);

      const isRequest = false;
      const userActivated = false;

      forks[currentFork].lastEpoch += 1;
      await checkEpoch(forks[currentFork].lastEpoch);

      await checkLastEpoch(isRequest, userActivated);
      await checkLastEpochNumber();
    });

    it(`ORE#${ORBEPochNumber}: operator submits ORBs`, async () => {
      const epoch = new Data.Epoch(await rootchain.getEpoch(currentFork, ORBEPochNumber));
      await logEpochAndBlock(currentFork, forks[currentFork].lastEpoch);

      const numORBs = epoch.endBlockNumber.sub(epoch.startBlockNumber).add(1);
      await submitDummyORBs(numORBs);

      forks[currentFork].lastEpoch += 1;
      await checkEpoch(forks[currentFork].lastEpoch);

      const isRequest = true;
      const userActivated = false;

      await checkLastEpoch(isRequest, userActivated);
      await checkLastEpochNumber();
    });

    it('can finalize blocks', finalizeBlocks);

    it('should finalize requests', applyRequests);
  };

  const testEpochsWithExitRequest = (NRBEPochNumber) => {
    const ORBEPochNumber = NRBEPochNumber + 1;

    before(async () => {
      await logEpoch(currentFork, NRBEPochNumber - 2);
      await logEpoch(currentFork, NRBEPochNumber - 1);
      await logEpoch(currentFork, NRBEPochNumber);

      const fork = forks[currentFork];
      const rebase = currentFork !== 0 && fork.firstEpoch + 2 === fork.lastEpoch;
      const isRequest = NRBEPochNumber !== 1 && !rebase;
      const userActivated = false;

      await checkEpoch(forks[currentFork].lastEpoch);
      await checkLastEpoch(isRequest, userActivated, rebase);

      await checkLastBlockNumber();
      await checkLastEpochNumber();
    });

    it(`NRE#${NRBEPochNumber}: user can make an exit request for token withdrawal`, async () => {
      const isTransfer = false;

      (await rootchain.getNumEROs()).should.be.bignumber.equal(numEROs);

      const txs = await Promise.all(others.map(other => {
        const trieKey = calcTrieKey(other);
        const trieValue = padLeft(web3.toHex(exitAmount));

        return rootchain.startExit(token.address, trieKey, trieValue, { from: other, value: COST_ERU });
      }));

      txs.forEach(logtx);

      numEROs += others.length;

      (await rootchain.getNumEROs()).should.be.bignumber.equal(numEROs);
    });

    it(`NRE#${NRBEPochNumber}: operator submits NRBs`, async () => {
      const isRequest = false;
      const userActivated = false;

      await submitDummyNRBs(NRELength);

      forks[currentFork].lastEpoch += 1;
      await checkEpoch(forks[currentFork].lastEpoch);

      await checkLastEpoch(isRequest, userActivated);
      await checkLastEpochNumber();
    });

    it(`ORE#${ORBEPochNumber}: operator submits ORBs`, async () => {
      const isRequest = true;
      const userActivated = false;

      const epoch = new Data.Epoch(await rootchain.getEpoch(currentFork, ORBEPochNumber));

      const numORBs = epoch.endBlockNumber.sub(epoch.startBlockNumber).add(1);
      await submitDummyORBs(numORBs);

      forks[currentFork].lastEpoch += 1;
      await checkEpoch(forks[currentFork].lastEpoch);

      await checkLastEpoch(isRequest, userActivated);
      await checkLastEpochNumber();
    });

    it('can finalize blocks', finalizeBlocks);

    it('should finalize requests', applyRequests);
  };

  const testEpochsWithInvalidExitRequest = (NRBEPochNumber) => {
    const ORBEPochNumber = NRBEPochNumber + 1;
    const invalidExit = true;

    before(async () => {
      log(`
        Epoch#${forks[currentFork].lastEpoch - 1} ${await rootchain.getEpoch(currentFork, forks[currentFork].lastEpoch - 1)}
        Epoch#${forks[currentFork].lastEpoch} ${await rootchain.getEpoch(currentFork, forks[currentFork].lastEpoch)}
        `);

      const fork = forks[currentFork];
      const rebase = currentFork !== 0 && fork.firstEpoch + 2 === fork.lastEpoch;
      const isRequest = NRBEPochNumber !== 1 && !rebase;
      const userActivated = false;

      await checkEpoch(forks[currentFork].lastEpoch);
      await checkLastEpoch(isRequest, userActivated, rebase);

      await checkLastBlockNumber();
      await checkLastEpochNumber();
    });

    it(`NRE#${NRBEPochNumber}: user can make an invalid exit request for token withdrawal`, async () => {
      const isTransfer = false;

      (await rootchain.getNumEROs()).should.be.bignumber.equal(numEROs);

      const txs = await Promise.all(others.map(other => {
        const trieKey = calcTrieKey(other);
        const trieValue = padLeft(web3.toHex(tokenAmount.mul(10)));

        return rootchain.startExit(token.address, trieKey, trieValue, { from: other, value: COST_ERU });
      }));
      txs.forEach(logtx);

      numEROs += others.length;

      (await rootchain.getNumEROs()).should.be.bignumber.equal(numEROs);
    });

    it(`NRE#${NRBEPochNumber}: operator submits NRBs`, async () => {
      const isRequest = false;
      const userActivated = false;

      await submitDummyNRBs(NRELength);

      forks[currentFork].lastEpoch += 1;
      await checkEpoch(forks[currentFork].lastEpoch);

      await checkLastEpoch(isRequest, userActivated);
      await checkLastEpochNumber();
    });

    it(`ORE#${ORBEPochNumber}: operator submits ORBs`, async () => {
      const isRequest = true;
      const userActivated = false;

      const epoch = new Data.Epoch(await rootchain.getEpoch(currentFork, ORBEPochNumber));

      const numORBs = epoch.endBlockNumber.sub(epoch.startBlockNumber).add(1);
      await submitDummyORBs(numORBs);

      forks[currentFork].lastEpoch += 1;
      await checkEpoch(forks[currentFork].lastEpoch);

      await checkLastEpoch(isRequest, userActivated);
      await checkLastEpochNumber();
    });

    it('can finalize blocks', finalizeBlocks);

    it('can challenge on invalid exit', async () => {
      await logEpochAndBlock(currentFork, ORBEPochNumber);
      const epoch = new Data.Epoch(await rootchain.getEpoch(currentFork, ORBEPochNumber));

      epoch.isRequest.should.be.equal(true);

      const numORBs = epoch.endBlockNumber.sub(epoch.startBlockNumber).add(1);

      for (const blockNumber of range(epoch.startBlockNumber, epoch.endBlockNumber.add(1))) {
        const block = new Data.PlasmaBlock(await rootchain.getBlock(currentFork, blockNumber));

        block.finalized.should.be.equal(true);

        const requestBlock = new Data.RequestBlock(await rootchain.EROs(block.requestBlockId));
        const numRequestsInBlock = epoch.requestEnd - epoch.requestStart + 1;

        for (const i of range(numRequestsInBlock)) {
          const tx = await rootchain.challengeExit(
            currentFork,
            blockNumber,
            i,
            failedReceipt,
            dummyProof
          );
          logtx(tx);
        }
      }
    });

    it('should finalize invalid requests', async () => { applyRequests(invalidExit); });
  };

  const makeUAFTest = ({
    numNREs = 0,
    numOREs = 0,
    makeEnter = false,
    makeExit = false,
  }) => {
    const args = { numNREs, numOREs, makeEnter, makeExit };

    const isOREEmpty = numOREs === 0;
    const isNREEmpty = numNREs === 0;

    const testUAF = (NRBEPochNumber) => {
      const ORBEPochNumber = NRBEPochNumber + 1;
      let numORBs = 0;
      let numNRBs = 0;

      before(async () => {
        if (numOREs > numNREs) {
          throw new Error(`numOREs can't be greater than numNREs, but ${numOREs} > ${numNREs}`);
        }

        log(`
          Epoch#${forks[currentFork].lastEpoch} ${await rootchain.getEpoch(currentFork, forks[currentFork].lastEpoch)}
          Epoch#${forks[currentFork].lastEpoch + 1} ${await rootchain.getEpoch(currentFork, forks[currentFork].lastEpoch + 1)}
        `);

        // finalize all blocks
        await finalizeBlocks();

        // extend unfinalized epcohs
        let i = numNREs;
        let j = numOREs;

        while (i + j > 0) {
          if (i > 0) {
            // create request before submit NRBs
            if (j > 0) {
              if (makeEnter) {
                const txs = await Promise.all(others.map(other => {
                  const isTransfer = false;
                  const trieKey = calcTrieKey(other);
                  const trieValue = padLeft(web3.fromDecimal(tokenAmount));
                  return rootchain.startEnter(isTransfer, token.address, trieKey, trieValue, { from: other });
                }));
                txs.forEach(logtx);
                numEROs += others.length;
              }

              if (makeExit) {
                const txs = await Promise.all(others.map(other => {
                  const trieKey = calcTrieKey(other);
                  const trieValue = padLeft(web3.toHex(tokenAmount.mul(10)));

                  return rootchain.startExit(token.address, trieKey, trieValue, { from: other, value: COST_ERU });
                }));
                txs.forEach(logtx);
                numEROs += others.length;
              }
            }

            // submit NRBs
            await submitDummyNRBs(NRELength);
            forks[currentFork].lastEpoch += 1;
            numNRBs += Number(NRELength);
            i--;
          }

          // submit ORBs
          if (j > 0) {
            const epoch = new Data.Epoch(await rootchain.getEpoch(currentFork, ORBEPochNumber));
            const numBlocks = epoch.endBlockNumber.sub(epoch.startBlockNumber).add(1);
            await submitDummyORBs(numBlocks);
            forks[currentFork].lastEpoch += 1;
            await logEpoch(currentFork, forks[currentFork].lastEpoch - 2);
            await logEpoch(currentFork, forks[currentFork].lastEpoch - 1);
            await logEpoch(currentFork, forks[currentFork].lastEpoch);
            await logEpoch(currentFork, forks[currentFork].lastEpoch + 1);

            numORBs += Number(numBlocks);
            j--;
          }
        }
      });

      it('should make ERUs', async () => {
        const txs = await Promise.all(others.map(other => {
          const trieKey = calcTrieKey(other);
          const trieValue = padLeft(web3.toHex(tokenAmount.mul(10)));

          return rootchain.makeERU(token.address, trieKey, trieValue, { from: other, value: COST_ERU });
        }));
        txs.forEach(logtx);
      });

      it('should prepare URE', async () => {
        await rootchain.prepareToSubmitURB({ from: submiter, value: COST_URB_PREPARE });
      });

      const caption = numORBs > 0 ? 'without empty ORE\'' : 'with empty ORE;';

      it(`should submit URB ${caption}`, async () => {
        await newFork();

        const nextFork = new Data.Fork(await rootchain.forks(currentFork));

        log(`Fork#${currentFork} ${JSON.stringify(nextFork)}`);

        await logEpochAndBlock(currentFork, nextFork.lastEpoch);

        await submitDummyURBs(1);

        await checkEpoch(forks[currentFork].lastEpoch);

        if (isOREEmpty && isNREEmpty) {
          forks[currentFork].lastEpoch += 2;

          const isRequest = false;
          const userActivated = false;
          const rebase = true;

          await checkLastEpoch(isRequest, userActivated, rebase);
        } else if (isOREEmpty) {
          forks[currentFork].lastEpoch += 1;

          const isRequest = true;
          const userActivated = false;
          const rebase = true;

          await checkLastEpoch(isRequest, userActivated, rebase);
        } else {
          const isRequest = true;
          const userActivated = true;
          await checkLastEpoch(isRequest, userActivated);
        }

        await checkLastEpochNumber();
      });

      if (!isOREEmpty) {
        it('should rebase ORE\'', async () => {
          const nextFork = new Data.Fork(await rootchain.forks(currentFork));
          await submitDummyORBs(numORBs);
          // log(`Fork#${currentFork - 1} ${JSON.stringify(new Data.Fork(await rootchain.forks(currentFork - 1)))}`);
          // log(`Fork#${currentFork} ${JSON.stringify(new Data.Fork(await rootchain.forks(currentFork)))}`);
          await logEpochAndBlock(currentFork, nextFork.lastEpoch);

          forks[currentFork].lastEpoch += 1;
          await checkEpoch(forks[currentFork].lastEpoch);

          // await checkLastEpoch(isRequest, userActivated);
          await checkLastEpochNumber();
        });
      }

      if (!isNREEmpty) {
        it('should rebase NRE\'', async () => {
          const nextFork = new Data.Fork(await rootchain.forks(currentFork));
          await submitDummyNRBs(numNRBs);
          log(`Fork#${currentFork - 1} ${JSON.stringify(new Data.Fork(await rootchain.forks(currentFork - 1)))}`);
          log(`Fork#${currentFork} ${JSON.stringify(new Data.Fork(await rootchain.forks(currentFork)))}`);
          await logEpochAndBlock(currentFork, nextFork.lastEpoch);

          forks[currentFork].lastEpoch += 1;
          await checkEpoch(forks[currentFork].lastEpoch);

          // await checkLastEpoch(isRequest, userActivated);
          await checkLastEpochNumber();
        });
      }
    };

    return {
      fname: `testUAF${JSON.stringify(args)}`,
      f: testUAF,
      isUAF: true,
    };
  };

  const scenario1 = [];
  scenario1.push(testEpochsWithoutRequest);
  scenario1.push(testEpochsWithoutRequest);
  scenario1.push(testEpochsWithoutRequest);
  scenario1.push(testEpochsWithRequest);
  scenario1.push(testEpochsWithRequest);
  scenario1.push(testEpochsWithRequest);
  scenario1.push(makeUAFTest({
    numNREs: 1,
    numOREs: 1,
    makeEnter: true,
    makeExit: true,
  }));
  scenario1.push(testEpochsWithExitRequest);

  const scenario2 = [];
  scenario2.push(testEpochsWithoutRequest);
  scenario2.push(testEpochsWithRequest);
  scenario2.push(makeUAFTest({
    numNREs: 1,
    numOREs: 1,
    makeEnter: true,
    makeExit: true,
  }));
  scenario2.push(testEpochsWithExitRequest);

  const tests = scenario1;

  // generate mocha test cases
  let forkNumber = 0;
  let epochNumber = 1;
  for (const i of range(0, tests.length)) {
    const t = tests[i];

    const {
      fname = t.name,
      f = t,
      isUAF = false,
    } = t;

    if (isUAF) {
      forkNumber += 1;
    }

    describe(`${i + 1}: Fork#${forkNumber} Epoch#${epochNumber} (${fname})`, () => {
      f(epochNumber);
    });

    if (isUAF) {
      epochNumber += 3;
    } else {
      epochNumber += 2;
    }
  }
});

function timeout (sec) {
  return new Promise((resolve) => {
    setTimeout(resolve, sec * 1000);
  });
}

function calcTrieKey (addr) {
  return web3.sha3(appendHex(padLeft(addr), padLeft('0x02')), { encoding: 'hex' });
}

function log (...args) {
  if (VERBOSE) console.log(...args);
}

function logtx (tx) {
  delete (tx.receipt.logsBloom);
  delete (tx.receipt.v);
  delete (tx.receipt.r);
  delete (tx.receipt.s);
  delete (tx.receipt.logs);
  tx.logs = tx.logs.map(({ event, args }) => ({ event, args }));
  if (LOGTX) console.log(JSON.stringify(tx, null, 2));
}
