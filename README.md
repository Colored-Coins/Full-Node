# Colored Coins Full-Node

## *This is a work in progress module!*

* This module, coupled with [bitcoin-core](https://bitcoin.org) reference client, will add the colored layer to bitcoin transactions and their inputs \ outputs.
* It will expose the same api as the reference client with an addition of `assets` array on each transaction input \ output.
* It will enable a user to setup an easy to deploy colored coins full node with relatively short parsing time with low disk \ memory space.
* It will replace the heavy [Colored Coins Block Explorer](https://github.com/Colored-Coins/Colored-Coins-Block-Explorer) for most use-cases.

### Dependencies:
* [bitcoin-core](https://bitcoin.org).
* [redis](https://redis.io).
