class WorkBuddyService {

 async execute(task:string){

    return await worker.run(task);

 }

}